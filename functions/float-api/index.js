'use strict';

const impl = require('./handler')

exports.accrue = (event) => {
    return impl.accrue(event, null);
};