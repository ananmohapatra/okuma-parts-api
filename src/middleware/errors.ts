/* eslint-disable max-classes-per-file */
/** Base application error class that attaches an HTTP status code to standard Error instances. */
export class AppError extends Error {
    status: number;

    /**
     * Creates an AppError with a human-readable message and an HTTP status code.
     * @param {string} message - Human-readable error description.
     * @param {number} [status] - HTTP status code; defaults to 500.
     */
    constructor(message: string, status = 500) {
        super(message);
        this.name = this.constructor.name;
        this.status = status;
    }
}

/** Error representing a 400 Bad Request caused by invalid input, with optional per-field detail entries. */
export class ValidationError extends AppError {
    details: { field: string; message: string }[];

    /**
     * Creates a ValidationError with a summary message and optional field-level details.
     * @param {string} message - Summary of the validation failure.
     * @param {{ field: string; message: string }[]} [details] - Array of per-field validation messages.
     */
    constructor(message: string, details: { field: string; message: string }[] = []) {
        super(message, 400);
        this.details = details;
    }
}

/** Error representing a 404 Not Found response. */
export class NotFoundError extends AppError {
    /**
     * Creates a NotFoundError with an optional custom message.
     * @param {string} [message] - Error message; defaults to 'Not found'.
     */
    constructor(message = 'Not found') {
        super(message, 404);
    }
}

/** Error representing a 401 Unauthorized response. */
export class UnauthorizedError extends AppError {
    /**
     * Creates an UnauthorizedError with an optional custom message.
     * @param {string} [message] - Error message; defaults to 'Unauthorized'.
     */
    constructor(message = 'Unauthorized') {
        super(message, 401);
    }
}
