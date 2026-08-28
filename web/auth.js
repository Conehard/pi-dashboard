const ASSET_VERSION = '__ASSET_VERSION__'

import { initI18n, t } from './src/core/i18n.js'

let appLoaded = false

function show (id) {
  ;['setup-screen', 'login-screen', 'app-shell'].forEach((elId) => {
    document.getElementById(elId).classList.toggle('hidden', elId !== id)
  })
}

function showSetup () { show('setup-screen') }
function showLogin () { show('login-screen') }

function showApp () {
  show('app-shell')
  if (!appLoaded) {
    appLoaded = true
    const script = document.createElement('script')
    script.type = 'module'
    script.src = `src/app.js?v=${ASSET_VERSION}`
    document.body.appendChild(script)
  }
}

const nativeFetch = window.fetch.bind(window)
window.fetch = async (...args) => {
  const res = await nativeFetch(...args)
  const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || ''
  if (res.status === 401 && !url.includes('/api/auth/')) {
    showLogin()
  }
  return res
}

async function checkAuthState () {
  try {
    const res = await nativeFetch('/api/auth/status')
    const data = await res.json()
    if (!data.ok) return 'login'
    if (data.needsSetup) return 'setup'
    return data.authenticated ? 'app' : 'login'
  } catch {
    return 'login'
  }
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorBox = document.getElementById('login-error')
  errorBox.classList.add('hidden')

  const username = document.getElementById('login-username').value
  const password = document.getElementById('login-password').value

  try {
    const res = await nativeFetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    document.getElementById('login-password').value = ''
    showApp()
  } catch (err) {
    errorBox.textContent = err.message
    errorBox.classList.remove('hidden')
  }
})

document.getElementById('logout-btn').addEventListener('click', async () => {
  try {
    await nativeFetch('/api/auth/logout', { method: 'POST' })
  } finally {
    location.reload()
  }
})

const STRONG_PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+'

function generateStrongPassword (length = 20) {
  const bytes = new Uint32Array(length)
  window.crypto.getRandomValues(bytes)
  return Array.from(bytes, (n) => STRONG_PASSWORD_CHARS[n % STRONG_PASSWORD_CHARS.length]).join('')
}

const setupPasswordInput = document.getElementById('setup-password')
const setupConfirmInput = document.getElementById('setup-password-confirm')
const setupCopyBtn = document.getElementById('setup-copy-btn')
let setupRevealed = false

function setSetupRevealed (revealed) {
  setupRevealed = revealed
  const type = revealed ? 'text' : 'password'
  setupPasswordInput.type = type
  setupConfirmInput.type = type
  document.getElementById('setup-reveal-btn').textContent = revealed ? t('common.hide') : t('common.show')
}

document.getElementById('setup-reveal-btn').addEventListener('click', () => setSetupRevealed(!setupRevealed))

document.getElementById('setup-generate-btn').addEventListener('click', () => {
  const generated = generateStrongPassword()
  setupPasswordInput.value = generated
  setupConfirmInput.value = generated
  setSetupRevealed(true)
  setupCopyBtn.classList.remove('hidden')
  setupCopyBtn.textContent = t('auth.setup.copyBtn')
})

setupCopyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(setupPasswordInput.value)
    setupCopyBtn.textContent = t('auth.setup.copied')
    setTimeout(() => { setupCopyBtn.textContent = t('auth.setup.copyBtn') }, 2000)
  } catch {
    setupCopyBtn.textContent = t('auth.setup.copyFailed')
  }
})

document.getElementById('setup-form').addEventListener('submit', async (event) => {
  event.preventDefault()
  const errorBox = document.getElementById('setup-error')
  errorBox.classList.add('hidden')

  const username = document.getElementById('setup-username').value.trim()
  const password = setupPasswordInput.value
  const confirmPassword = setupConfirmInput.value

  if (password !== confirmPassword) {
    errorBox.textContent = t('auth.setup.passwordMismatch')
    errorBox.classList.remove('hidden')
    return
  }

  try {
    const res = await nativeFetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
    const data = await res.json()
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    showApp()
  } catch (err) {
    errorBox.textContent = err.message
    errorBox.classList.remove('hidden')
  }
})

initI18n().then(() => {
  checkAuthState().then((state) => {
    if (state === 'app') showApp()
    else if (state === 'setup') showSetup()
    else showLogin()
  })
})
