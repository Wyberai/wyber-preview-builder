const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const crypto = require('crypto')

const app = express()
const PORT = process.env.PORT || 3001
const BUILDS_DIR = '/tmp/wyber-builds'
const WORK_DIR = '/tmp/wyber-work'

app.use(cors({ origin: '*' }))
app.use(express.json({ limit: '10mb' }))

app.use('/preview', (req, res, next) => {
  res.setHeader('X-Frame-Options', 'ALLOWALL')
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Content-Security-Policy', "frame-ancestors *")
  next()
}, express.static(BUILDS_DIR))

app.get('/health', (_, res) => res.json({ status: 'ok', ts: Date.now() }))

app.post('/build', async (req, res) => {
  const { files, projectId } = req.body
  if (!files) return res.status(400).json({ error: 'No files provided' })

  const hash = crypto.createHash('md5').update(JSON.stringify(files)).digest('hex').slice(0, 12)
  const buildPath = path.join(BUILDS_DIR, hash)
  const previewUrl = `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/preview/${hash}/index.html`

  // Return cached build if exists
  if (fs.existsSync(path.join(buildPath, 'index.html'))) {
    return res.json({ url: previewUrl, cached: true })
  }

  const workPath = path.join(WORK_DIR, hash)
  try {
    fs.mkdirSync(workPath, { recursive: true })

    // Write package.json
    fs.writeFileSync(path.join(workPath, 'package.json'), JSON.stringify({
      name: 'wyber-app', private: true, version: '0.1.0', type: 'module',
      scripts: { build: 'vite build' },
      dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'react-router-dom': '^6.28.0', 'lucide-react': '^0.383.0', recharts: '^2.12.0', clsx: '^2.1.1', 'date-fns': '^3.6.0', zustand: '^4.5.2' },
      devDependencies: { '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1', '@vitejs/plugin-react': '^4.3.3', typescript: '^5.6.3', vite: '^5.4.10' }
    }, null, 2))

    // Write vite config
    fs.writeFileSync(path.join(workPath, 'vite.config.ts'), `import { defineConfig } from 'vite'\nimport react from '@vitejs/plugin-react'\nexport default defineConfig({ plugins: [react()], build: { outDir: 'dist', sourcemap: false } })`)

    // Write tsconfig
    fs.writeFileSync(path.join(workPath, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2020', lib: ['ES2020','DOM','DOM.Iterable'], module: 'ESNext', skipLibCheck: true, moduleResolution: 'bundler', allowImportingTsExtensions: true, noEmit: true, jsx: 'react-jsx', strict: false }, include: ['src'] }, null, 2))

    // Write index.html
    fs.writeFileSync(path.join(workPath, 'index.html'), `<!doctype html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/><title>Wyber App</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>`)

    // Write user files
    for (const [filePath, fileData] of Object.entries(files)) {
      const content = typeof fileData === 'string' ? fileData : (fileData?.content || '')
      if (!content.trim()) continue
      const fullPath = path.join(workPath, filePath.replace(/^\//, ''))
      fs.mkdirSync(path.dirname(fullPath), { recursive: true })
      fs.writeFileSync(fullPath, content)
    }

    // Ensure main.tsx exists
    const mainPath = path.join(workPath, 'src/main.tsx')
    if (!fs.existsSync(mainPath)) {
      const hasApp = fs.existsSync(path.join(workPath, 'src/App.tsx'))
      fs.writeFileSync(mainPath, `import { StrictMode } from 'react'\nimport { createRoot } from 'react-dom/client'\nimport { BrowserRouter } from 'react-router-dom'\n${hasApp ? "import App from './App'" : ''}\nimport './index.css'\ncreateRoot(document.getElementById('root')!).render(<StrictMode><BrowserRouter>${hasApp ? '<App />' : '<div>App</div>'}</BrowserRouter></StrictMode>)`)
    }

    // Use cached node_modules from warmup if available
    const WARMUP = '/tmp/wyber-warmup'
    if (fs.existsSync(path.join(WARMUP, 'node_modules'))) {
      fs.symlinkSync(path.join(WARMUP, 'node_modules'), path.join(workPath, 'node_modules'))
    } else {
      execSync('npm install --no-audit --no-fund', { cwd: workPath, timeout: 120000, stdio: 'pipe' })
    }

    execSync('npm run build', { cwd: workPath, timeout: 60000, stdio: 'pipe' })

    // Move dist to builds
    fs.mkdirSync(buildPath, { recursive: true })
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

// Pre-warm npm cache
const WARMUP = '/tmp/wyber-warmup'
if (!fs.existsSync(WARMUP)) {
  fs.mkdirSync(WARMUP, { recursive: true })
  fs.writeFileSync(path.join(WARMUP, 'package.json'), JSON.stringify({
    name:'warmup',private:true,version:'0.0.0',type:'module',
    dependencies:{react:'^18.3.1','react-dom':'^18.3.1','react-router-dom':'^6.28.0','lucide-react':'^0.383.0',recharts:'^2.12.0',clsx:'^2.1.1','date-fns':'^3.6.0',zustand:'^4.5.2'},
    devDependencies:{'@types/react':'^18.3.1','@types/react-dom':'^18.3.1','@vitejs/plugin-react':'^4.3.1',typescript:'^5.5.3',vite:'^5.4.1'}
  }))
  try { execSync('npm install --no-audit --no-fund', { cwd: WARMUP, timeout: 120000, stdio: 'pipe' }); console.log('npm cache warmed') }
  catch(e) { console.log('Warmup failed (non-critical)') }
}

app.listen(PORT, () => console.log(`Wyber preview builder on port ${PORT}`))
