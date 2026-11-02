/** The one error type the app throws and shows. Kept in its own tiny file so pages that never touch the database do not load Firebase. */
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) { super(message); this.status = status; this.code = code; }
}
