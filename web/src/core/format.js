import { getLanguage } from './i18n.js'

const LOCALE_BY_LANGUAGE = { pt: 'pt-BR', en: 'en-US' }

function currentLocale () {
  return LOCALE_BY_LANGUAGE[getLanguage()] || LOCALE_BY_LANGUAGE.pt
}

export function fmtDateTime (value) {
  if (!value) return '--'
  return new Date(value).toLocaleString(currentLocale())
}

export function fmtTime (value) {
  if (!value) return '--'
  return new Date(value).toLocaleTimeString(currentLocale())
}

export function fmtNumber (value, digits, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return '--'
  return Number(value).toFixed(digits === undefined ? 1 : digits) + suffix
}

export function orDash (value, format = String) {
  return value === null || value === undefined ? '--' : format(value)
}

export function fmtBytes (bytes) {
  if (bytes === null || bytes === undefined) return '--'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}
