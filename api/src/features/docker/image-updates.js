import { docker } from '../../lib/docker-client.js'
import { getDockerSnapshot } from './metrics.js'
import { createLogger } from '../../lib/logger.js'

const log = createLogger('image-update-checker')
const POLL_INTERVAL_MS = Number(process.env.IMAGE_UPDATE_CHECK_INTERVAL_MS) || 12 * 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 8000
const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json'
].join(', ')

let cache = new Map()
let timer = null

function parseImageRef (ref) {
  const lastColon = ref.lastIndexOf(':')
  const lastSlash = ref.lastIndexOf('/')
  const hasTag = lastColon > lastSlash
  const tag = hasTag ? ref.slice(lastColon + 1) : 'latest'
  let repoPart = hasTag ? ref.slice(0, lastColon) : ref

  const firstSlash = repoPart.indexOf('/')
  const firstSegment = firstSlash === -1 ? repoPart : repoPart.slice(0, firstSlash)
  const looksLikeHost = firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost'
  if (looksLikeHost) return null

  if (firstSlash === -1) repoPart = `library/${repoPart}`
  return { repository: repoPart, tag }
}

async function getRemoteDigest (repository, tag) {
  const tokenRes = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`,
    { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) }
  )
  if (!tokenRes.ok) throw new Error(`falha ao obter token anônimo (HTTP ${tokenRes.status})`)
  const { token } = await tokenRes.json()

  const manifestRes = await fetch(
    `https://registry-1.docker.io/v2/${repository}/manifests/${tag}`,
    {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${token}`, Accept: MANIFEST_ACCEPT },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)
    }
  )
  if (!manifestRes.ok) throw new Error(`registro respondeu HTTP ${manifestRes.status}`)
  const digest = manifestRes.headers.get('docker-content-digest')
  if (!digest) throw new Error('resposta sem header Docker-Content-Digest')
  return digest
}

async function getLocalDigest (imageRef) {
  const info = await docker.getImage(imageRef).inspect()
  const digests = info.RepoDigests || []
  const repoOnly = imageRef.split(':')[0]
  const match = digests.find((d) => d.startsWith(`${repoOnly}@`)) || digests[0]
  return match ? match.split('@')[1] : null
}

function isLocallyBuilt (imageRef) {
  return imageRef.startsWith('pi-dashboard-') || imageRef.endsWith(':local')
}

async function checkOne (imageRef) {
  if (isLocallyBuilt(imageRef)) return null
  const parsed = parseImageRef(imageRef)
  if (!parsed) return null

  let localDigest
  try {
    localDigest = await getLocalDigest(imageRef)
  } catch (err) {
    return { image: imageRef, updateAvailable: null, checkedAt: new Date().toISOString(), error: `inspeção local falhou: ${err.message}` }
  }
  if (!localDigest) return null

  try {
    const remoteDigest = await getRemoteDigest(parsed.repository, parsed.tag)
    return {
      image: imageRef,
      updateAvailable: localDigest !== remoteDigest,
      checkedAt: new Date().toISOString(),
      error: null
    }
  } catch (err) {
    return { image: imageRef, updateAvailable: null, checkedAt: new Date().toISOString(), error: err.message }
  }
}

async function pollOnce () {
  try {
    const snapshot = await getDockerSnapshot()
    if (!snapshot.available) return

    const images = [...new Set(snapshot.containers.map((c) => c.image))]
    const next = new Map()
    for (const image of images) {
      const result = await checkOne(image)
      if (result) next.set(image, result)
    }
    cache = next
  } catch (err) {
    log.error('poll failed', err.message)
  }
}

export function getImageUpdatesSnapshot () {
  return Object.fromEntries(cache)
}

export function startImageUpdateChecker () {
  if (timer) return
  pollOnce()
  timer = setInterval(pollOnce, POLL_INTERVAL_MS)
  timer.unref()
  log.info(`image update checker started (every ${POLL_INTERVAL_MS}ms)`)
}
