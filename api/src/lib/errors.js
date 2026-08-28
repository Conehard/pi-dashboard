export class ActionError extends Error {
  constructor (message, statusCode, vars) {
    super(message)
    this.statusCode = statusCode
    this.vars = vars
  }
}
