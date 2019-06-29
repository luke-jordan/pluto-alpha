'use strict';

const user_insertion_handler = require('./user-insertion-handler')
const user_credentials_verification_handler = require('./user-credentials-verification-handler')
const password_update_handler = require('./password-update-handler')
const jwt_handler = require('./jwt-handler')


exports.insertUserCredentials = async (event) => {
    return await user_insertion_handler.insertUserCredentials(event, null);
};

exports.verifyUserCredentials = async (event) => {
    return await user_credentials_verification_handler.verifyUserCredentials(event, null);
};

exports.updatePassword = async (event) => {
    return await password_update_handler.updatePassword(event, null);
};

exports.verifyJsonWebToken = async (event) => {
    return await jwt_handler.verifyJsonWebToken(event, null);
};

exports.signJsonWebToken = async (event) => {
    return await jwt_handler.signJsonWebToken(event, null);
};