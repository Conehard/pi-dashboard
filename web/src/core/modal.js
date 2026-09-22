// A small reusable modal primitive, built on the native <dialog> element (built-in focus trap,
// Escape-to-close, ::backdrop) - not Tuya-specific, any current/future screen can use it. First real
// modal in this codebase (checked: nothing like it existed before - every other "more detail" pattern
// so far has been an inline expandable panel, e.g. Docker's container Logs/Details box).
import { t } from './i18n.js'

// `body` can be a Node (appended as-is) or a function `(dialog) => Node|void` if the content needs a
// reference back to the dialog itself (e.g. to close it from inside a button handler).
export function openModal ({ title, body, onClose } = {}) {
  const dialog = document.createElement('dialog')
  dialog.className = 'pd-modal'

  const header = document.createElement('div')
  header.className = 'pd-modal-header'
  const h3 = document.createElement('h3')
  h3.textContent = title || ''
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'pd-modal-close'
  closeBtn.setAttribute('aria-label', t('common.close'))
  closeBtn.textContent = '×'
  closeBtn.addEventListener('click', () => dialog.close())
  header.append(h3, closeBtn)

  const bodyEl = document.createElement('div')
  bodyEl.className = 'pd-modal-body'
  const content = typeof body === 'function' ? body(dialog) : body
  if (content instanceof Node) bodyEl.appendChild(content)

  dialog.append(header, bodyEl)
  document.body.appendChild(dialog)

  dialog.addEventListener('close', () => {
    dialog.remove()
    if (onClose) onClose()
  })
  // A click directly on the <dialog> element itself (not something inside it) is a click on the
  // backdrop area within the dialog's own box model - the standard way to detect "clicked outside".
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  dialog.showModal()
  return dialog
}
