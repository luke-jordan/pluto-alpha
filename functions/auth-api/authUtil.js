// λfy
// if (createdBy !== admin) throw new Error('Action not allowed');
// else get admin policy from dynamo
// get user policies from dynamo
const logger = require('debug')('pluto:auth:auth-util');

const AWS = require('aws-sdk');
AWS.config.update({
    region: "us-east-1",
    endpoint: "http://localhost:8000"
});

const docClient = new AWS.DynamoDB.DocumentClient();

const table = "roles_and_permissions";

module.exports.assignUserRolesAndPermissions = (systemWideUserId, userRole, createdBy = 'newUser') => {
    if (!userRole) userRole = 'default';
    switch(userRole) {
        case 'default':
            return getPolicy("defaultUserPolicy", systemWideUserId);

        case 'admin':
            return getPolicy("adminUserPolicy", systemWideUserId);

        case 'support':
           return getPolicy("supportUserPolicy", systemWideUserId);

        default:
            return 'Undefined Policy';
    };
};


module.exports.getSignOptions = (systemWideUserId) => {
    return {
        issuer: 'Pluto Savings',
        subject: systemWideUserId,
        audience: 'https://plutosavings.com'
    };
};


const getPolicy =  async (policyName, systemWideUserId) => {
    const params = {
        TableName: table,
        Key: {
            policy_id: policyName
        }
    };
    try {
        const dynamoDbResult = await docClient.get(params).promise();
        console.log(Object.keys(dynamoDbResult.Item));
        dynamoDbResult.Item.systemWideUserId = systemWideUserId;
        logger('DynamoDB GetItem succeeded:', dynamoDbResult);
        return dynamoDbResult;
    } catch (err) {
        logger('DynamoDB GetItem failed with:', err.message);
        throw err;
    }
};