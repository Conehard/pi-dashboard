export function createLogger (scope) {
  const prefix = `[${scope}]`

  return {
    info: (...args) => console.log(new Date().toISOString(), prefix, ...args),
    error: (...args) => console.error(new Date().toISOString(), prefix, ...args)
  }
}
