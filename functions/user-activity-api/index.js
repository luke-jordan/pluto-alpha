'use strict';

const impl = require('./handler')

exports.handler = async (event) => {
    return await impl.save(event);
};