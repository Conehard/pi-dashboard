const STORAGE_KEY = 'pi-dashboard:lang'
const SUPPORTED_LANGUAGES = ['pt', 'en']
export const DEFAULT_LANGUAGE = 'en'

let currentLang = DEFAULT_LANGUAGE
let dict = {}

function readStoredLanguage () {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return SUPPORTED_LANGUAGES.includes(stored) ? stored : null
  } catch {
    return null
  }
}

async function loadDictionary (lang) {
  const res = await fetch(`src/i18n/${lang}.json`)
  return res.json()
}

const nativeFetch = window.fetch.bind(window)
window.fetch = (input, init = {}) => {
  const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined))
  headers.set('Accept-Language', currentLang)
  return nativeFetch(input, { ...init, headers })
}

export function getLanguage () {
  return currentLang
}

export function t (key, vars) {
  const template = dict[key]
  if (template === undefined) return key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? vars[name] : `{${name}}`))
}

export function translateDom (root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n) })
  root.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml) })
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder) })
  root.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle) })
  root.querySelectorAll('[data-i18n-aria-label]').forEach((el) => { el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel)) })
  document.documentElement.lang = currentLang === 'en' ? 'en' : 'pt-BR'
}

export async function initI18n () {
  currentLang = readStoredLanguage() || DEFAULT_LANGUAGE
  dict = await loadDictionary(currentLang)
  translateDom()
}

export async function setLanguage (lang) {
  if (!SUPPORTED_LANGUAGES.includes(lang) || lang === currentLang) return
  currentLang = lang
  try { localStorage.setItem(STORAGE_KEY, lang) } catch {  }
  dict = await loadDictionary(lang)
  translateDom()
  window.dispatchEvent(new CustomEvent('pd-lang-changed'))
}
