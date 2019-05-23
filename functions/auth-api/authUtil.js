// λfy
// if (createdBy !== admin) throw new Error('Action not allowed');
// else get admin policy from dynamo
// get user policies from dynamo
module.exports.assignUserRolesAndPermissions = (systemWideUserId, userRole, createdBy = 'newUser') => {
    if (!userRole) userRole = 'default';
    switch(userRole) {
        case 'default':
            return {
                systemWideUserId: systemWideUserId,
                role: "Default User Role",
                Permissions: [
                    "EditProfile",
                    "CreateWallet",
                    "CheckBalance"
                ]
            };
        case 'admin':
            return {
                systemWideUserId: systemWideUserId,
                role: "Admin Role",
                Permisssions: [
                    "ReadLogs",
                    "ReadPersistenceTables",
                    "CheckBalance"
                ]
            };
        case 'specialised_user':
            return {
                systemWideUserId: systemWideUserId,
                role: "Specialised User Role",
                Permissions: []
            };
    };
};


module.exports.getSignOptions = (systemWideUserId) => {
    return {
        issuer: 'Pluto Savings',
        subject: systemWideUserId,
        audience: 'https://plutosavings.com'
    };
}; 