'use strict';

module.exports.resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};
