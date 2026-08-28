const VIEWS = ['overview', 'docker', 'tasks', 'status', 'internet', 'settings']

function showView (view) {
  document.querySelectorAll('.view').forEach((el) => {
    el.classList.toggle('hidden', el.dataset.viewSection !== view)
  })
  document.querySelectorAll('.nav-link').forEach((a) => {
    a.classList.toggle('active', a.dataset.view === view)
  })
  document.getElementById('project-nav').classList.toggle('hidden', view !== 'docker')
}

function applyRoute () {
  const hash = (location.hash || '#overview').slice(1)
  if (VIEWS.includes(hash)) {
    showView(hash)
    return
  }
  if (hash.startsWith('project-')) {
    showView('docker')
  }
}

const sidebarEls = {
  sidebar: document.getElementById('sidebar'),
  backdrop: document.getElementById('sidebar-backdrop'),
  openBtn: document.getElementById('sidebar-open-btn'),
  closeBtn: document.getElementById('sidebar-close-btn')
}

function setSidebarOpen (open) {
  sidebarEls.sidebar.classList.toggle('open', open)
  sidebarEls.backdrop.classList.toggle('hidden', !open)
}

export function initRouter () {
  window.addEventListener('hashchange', applyRoute)
  applyRoute()

  sidebarEls.openBtn.addEventListener('click', () => setSidebarOpen(true))
  sidebarEls.closeBtn.addEventListener('click', () => setSidebarOpen(false))
  sidebarEls.backdrop.addEventListener('click', () => setSidebarOpen(false))
  window.addEventListener('hashchange', () => setSidebarOpen(false))
}
