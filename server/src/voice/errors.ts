/** An error that carries its HTTP status: bad input 400, not allowed 403, missing 404, bad file 415, over budget 429. */
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
