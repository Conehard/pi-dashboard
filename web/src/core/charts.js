export function resampleHistory (samples, key, bucketCount) {
  if (samples.length === 0) return []
  const bucketCountClamped = Math.min(bucketCount, samples.length)
  const bucketSize = samples.length / bucketCountClamped
  const points = []
  for (let i = 0; i < bucketCountClamped; i++) {
    const start = Math.floor(i * bucketSize)
    const end = Math.max(start + 1, Math.floor((i + 1) * bucketSize))
    const values = samples.slice(start, end).map(s => s[key]).filter(v => v !== null && v !== undefined)
    points.push(values.length ? values.reduce((a, b) => a + b, 0) / values.length : null)
  }
  return points
}

export function drawSparkline (canvas, data, color, totalPoints = data.length) {
  const ctx = canvas.getContext('2d')
  const width = canvas.clientWidth || canvas.width
  const height = canvas.clientHeight || canvas.height

  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height

  ctx.clearRect(0, 0, width, height)

  const values = data.filter(v => v !== null && v !== undefined)
  if (values.length < 2) return

  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = width / (totalPoints - 1)
  const offset = totalPoints - data.length

  ctx.beginPath()
  ctx.lineWidth = 1.5
  ctx.strokeStyle = color
  let started = false

  data.forEach((value, i) => {
    if (value === null || value === undefined) return
    const x = (offset + i) * stepX
    const y = height - ((value - min) / range) * (height - 4) - 2
    if (!started) {
      ctx.moveTo(x, y)
      started = true
    } else {
      ctx.lineTo(x, y)
    }
  })

  ctx.stroke()
}
