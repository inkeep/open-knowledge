export class AutoStartDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutoStartDisabledError';
  }
}
