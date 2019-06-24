'use strict';

const impl = require('./handler')

exports.accrue = async (event) => {
    return await impl.accrue() ;
};