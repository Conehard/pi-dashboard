import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const dictionaries = {
  pt: JSON.parse(readFileSync(path.join(__dirname, '../i18n/pt.json'), 'utf8')),
  en: JSON.parse(readFileSync(path.join(__dirname, '../i18n/en.json'), 'utf8'))
}

const SUPPORTED_LANGUAGES = Object.keys(dictionaries)
export const DEFAULT_LANGUAGE = 'en'

export function resolveLanguage (acceptLanguageHeader) {
  const candidate = (acceptLanguageHeader || '').slice(0, 2).toLowerCase()
  return SUPPORTED_LANGUAGES.includes(candidate) ? candidate : DEFAULT_LANGUAGE
}

export function t (lang, key, vars) {
  const dict = dictionaries[lang] || dictionaries[DEFAULT_LANGUAGE]
  const template = dict[key]
  if (template === undefined) return key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, name) => (vars[name] !== undefined ? vars[name] : `{${name}}`))
}
