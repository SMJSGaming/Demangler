export class NotMangledError extends Error {

    constructor() {
        super("The provided mangle is not valid");

        this.name = this.constructor.name;
        Error.captureStackTrace(this, this.constructor);
    }
}