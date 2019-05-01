// Helpfully sourced from https://rclayton.silvrback.com/custom-errors-in-node-js

class DomainError extends Error {
    constructor(message) {
      super(message);
     // Ensure the name of this error is the same as the class name
      this.name = this.constructor.name;
     // This clips the constructor invocation from the stack trace.
     // It's not absolutely essential, but it does make the stack trace a little nicer.
     //  @see Node.js reference (bottom)
      Error.captureStackTrace(this, this.constructor);
    }
}

class QueryError extends DomainError {
    constructor(template, values) {
      super(`Query with template ${template} and values ${JSON.stringify(values)} caused an error.`);
      this.data = { template, values };
    }
}

class CommitError extends DomainError {
    constructor(template, values) {
        super(`Query '${template}, with values ${JSON.stringify(values)} failed on commit`);
        this.data = { template, values };
    }
}

class NoValuesError extends DomainError {
    constructor(template) {
        super('All queries must include at least an empty value list. Always parametrize queries, do not use string templates');
        this.data = { template };
    }
}

module.exports = {
    QueryError,
    CommitError,
    NoValuesError
};
