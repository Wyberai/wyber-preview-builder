const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const crypto = require('crypto')

const app = express()
const PORT = process.env.PORT || 8080
const BUILDS_DIR = '/tmp/wyber-builds'
const WORK_DIR = '/tmp/wyber-work'
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || `localhost:${PORT}`

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }))
app.options('*', cors())
app.use(express.json({ limit: '50mb' }))

app.use('/preview', (req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Security-Policy', "frame-ancestors *")
  next()
}, express.static(BUILDS_DIR))

app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }))

app.post('/build', async (req, res) => {
  const { files, projectId } = req.body || {}
  if (!files) return res.status(400).json({ error: 'No files provided' })

  const hash = crypto.createHash('md5').update(JSON.stringify(files)).digest('hex').slice(0, 12)
  const buildPath = path.join(BUILDS_DIR, hash)
  const previewUrl = `https://${PUBLIC_DOMAIN}/preview/${hash}/index.html`

  if (fs.existsSync(path.join(buildPath, 'index.html'))) {
    return res.json({ url: previewUrl, cached: true })
  }

  const workPath = path.join(WORK_DIR, hash)
  try {
    fs.mkdirSync(workPath, { recursive: true })

    fs.writeFileSync(path.join(workPath, 'package.json'), JSON.stringify({
      name: 'wyber-app', private: true, version: '0.1.0', type: 'module',
      scripts: { build: 'vite build' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'react-router-dom': '^6.28.0', 'lucide-react': '^0.383.0', recharts: '^2.12.0', clsx: '^2.1.1', 'date-fns': '^3.6.0', zustand: '^4.5.2' },
      devDependencies: { '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1', '@vitejs/plugin-react': '^4.3.3', typescript: '^5.6.3', vite: '^5.4.10' }
    }, null, 2))

    fs.writeFileSync(path.join(workPath, 'vite.config.ts'), `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()], base: './', build: { outDir: 'dist', assetsDir: 'assets' } })`)
    fs.writeFileSync(path.join(workPath, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['ES2020','DOM','DOM.Iterable'], module: 'ESNext', skipLibCheck: true, moduleResolution: 'bundler', allowImportingTsExtensions: true, noEmit: true, jsx: 'react-jsx', strict: false }, include: ['src'] }, null, 2))
    fs.writeFileSync(path.join(workPath, 'index.html'), `<!doctype html><html><head><meta charset="UTF-8"/><title>Wyber App</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`)

    for (const [filePath, fileData] of Object.entries(files)) {
      let fileContent = typeof fileData === 'string' ? fileData : (fileData?.content || '')
      if (!fileContent.trim()) continue
      // Fix CSS: remove @import url() for Google Fonts (causes PostCSS parse errors)
      if (filePath.endsWith('.css')) {
        fileContent = fileContent.replace(/@import\s+url\([^)]+\);?\s*/g, '')
        fileContent = fileContent.replace(/@import\s+['"][^'"]+['"];?\s*/g, '')
      }
      const fullPath = path.join(workPath, filePath.replace(/^\//, ''))
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, fileContent)
    }

    if (!fs.existsSync(path.join(workPath, 'src/main.tsx'))) {
      const hasApp = fs.existsSync(path.join(workPath, 'src/App.tsx'))
      fs.writeFileSync(path.join(workPath, 'src/main.tsx'),
        `import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\n${hasApp ? "import App from './App'\n" : ''}import './index.css'\ncreateRoot(document.getElementById('root')!).render(<StrictMode>${hasApp ? '<App />' : '<div>App</div>'}</StrictMode>)`)
    }

    if (!fs.existsSync(path.join(workPath, 'src/index.css'))) {
      fs.writeFileSync(path.join(workPath, 'src/index.css'), '*{box-sizing:border-box;margin:0;padding:0}body{font-family:sans-serif}')
    }

    execSync('npm install --no-audit --no-fund', { cwd: workPath, timeout: 120000, stdio: 'pipe' })
    execSync('npm run build', { cwd: workPath, timeout: 60000, stdio: 'pipe' })

    fs.mkdirSync(buildPath, { recursive: true })

    // Fix asset paths to be relative
    const builtHtml = path.join(workPath, 'dist/index.html')
    if (fs.existsSync(builtHtml)) {
      let html = fs.readFileSync(builtHtml, 'utf8')
      html = html.replace(/src="\/assets\//g, 'src="./assets/')
      html = html.replace(/href="\/assets\//g, 'href="./assets/')
      fs.writeFileSync(builtHtml, html)
    }

    execSync(`cp -r ${workPath}/dist/. ${buildPath}/`)

    res.json({ url: previewUrl })
  } catch (err) {
    console.error('Build error:', err.message)
    res.status(422).json({ error: err.message || 'Build failed' })
  } finally {
    try { fs.rmSync(workPath, { recursive: true, force: true }) } catch {}
  }
})

fs.mkdirSync(BUILDS_DIR, { recursive: true })
fs.mkdirSync(WORK_DIR, { recursive: true })

app.listen(PORT, '0.0.0.0', () => console.log(`Wyber preview builder running on port ${PORT}`))
