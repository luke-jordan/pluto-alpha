// λfy
// if (createdBy !== admin) throw new Error('Action not allowed');
// else get admin policy from dynamo
// get user policies from dynamo

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
            return getPolicy("Default User Role");

        case 'admin':
            return getPolicy("Admin Role");
    
        case 'support_user':
            return getPolicy("Support User Role"); 
    };
};


module.exports.getSignOptions = (systemWideUserId) => {
    return {
        issuer: 'Pluto Savings',
        subject: systemWideUserId,
        audience: 'https://plutosavings.com'
    };
};


const getPolicy = (policyName, systemWideUserId) => {
    const params = {
        TableName: table,
        Key: {
            role: policyName
        }
    };
    docClient.get(params, (err, data) => {
        if (err) {
            logger("Unable to read item. Reason:", JSON.stringify(err, null, 4));
            throw new err;
        }
        else {
            logger("GetItem succeeded:", JSON.stringify(data, null, 4));
            data.systemWideUserId = systemWideUserId;
            return data;
        }
    });
}