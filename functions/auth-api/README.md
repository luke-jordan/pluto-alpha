# Auth-API

## Table of Contents

   * [Auth-API](#auth-api)
      * [General Sign up Flow (SRP)](#general-sign-up-flow-srp)
      * [General Login Flow (SRP)](#general-login-flow-srp)
      * [Data](#data)
         * [User Login Data (SRP)](#user-login-data-srp)
      * [Policies](#policies)
         * [Default User Policy](#default-user-policy)
         * [Admin Policy](#admin-policy)
         * [Password Policy](#password-policy)
      * [Persistence](#persistence)
         * [Postgresql (RDS)](#postgresql-rds)
      * [Authorization](#authorization)
         * [Basic Lambda Authorizer](#basic-lambda-authorizer)
      * [Password Reset/Update](#password-reset/change)
         * [Password Reset Lambda](#password-reset-lambda)    
         * [Password Update Lambda](#password-update-lambda)


## General Sign up Flow (SRP)

* A system wide user id, password, and requested user role are passed to the user insertion lambda. The insertion lambda expects an event of the form:
```
{
    "systemWideUserId": "4579c88b-798f-42a8-a851-d80e38e19e3a",
    "password": "someP0licyC0mpliantPassw0rd"
    "requestedUserRole": "default"
}
```
* The insertion lambda includes a password encrpyption algorithm which has a method that accepts the system wide user id and password as parameters and returns a salt key and a verifier key. The transformed object would be of the form:
```
{
    "systemWideUserId": "4579c88b-798f-42a8-a851-d80e38e19e3a",
    "salt": "da2b9a6e402200052...d",
    "verifier": "48352c7435da05bf2c5b...2"
}
```
* The insertion lambda then creates a persistable user object, consisting of the system wide user id, the salt key, the verifier key, and the objects creation time. An example user object created during this process is shown below.
```
{
    system_wide_user_id: "4579c88b-798f-42a8-a851-d80e38e19e3a",
    salt: "da2b9a6e402200052...d",
    verifier: "48352c7435da05bf2c5b...2",
    server_ephemeral_secret: null,
    creation_time: 1558704842900,
    updated_time: null
}
```
* The isertion lambda then assigns the user the roles and permissions associated with the requested role passed to it. It is worth noting here that only admin users can create users with protected roles and permissions (such as other admin users and support users).
* The user object is then persisted into an AWS RDS database which returns an insertion id if successful.
* If user insertion was successful, a JSON Web Token is generated for the user and sent back to the client as part of the final insertion lambda response. The response body of the insertion lambda on the advent of successful operations is of the form:
```
{
    "jwt": "ajson.web.token",
    "message": "Successfully inserted user <insertionId>"
}
```

* This conludes the current user insertion routine. It is worth noting one of the perks of this method is that the users actual password is never persisted.

## General Login Flow (SRP)
* As during user insertion, the login lambda accepts an event of the form
```
{
    "systemWideUserId": "4579c88b-798f-42a8-a851-d80e38e19e3a",
    "password": "someP0licyC0mpliantPassw0rd"
}
```
* You may note that this event is identical to that recieved during sign up. The only difference being the path the event is passed in to.
* The login lambda will validate the users credentials without sending the password to the server (for details on this process please see Login Details (SRP)). If user credentials check out, the lambda will respond with an object of the form
```
{
    "message": "success",
    "verified": true,
    "jwt": "eyJhbGciOiJIUzI1NiI...KI"
}
```
* On failure the object will be without the `jwt` key-value pair, `verified` will return false, and `message` will contain the reason for authentication failure. An example is provided below.
```
{
    "message": "invalid credentials",
    "verified": false
}
```

## Data
### User Login Data (SRP)
```
{
    "email": "johndoe@email.com",
    "salt": "da2b9a6e40220005234c...fd",
    "verifier": "48352c7435da05bf2c5bed...2"
}
```
The above is stored when a user signs in. During login, the above object is updated with a serverEphemeralSecret key. The resulting object will, for the duration of the login session, look like:
```
    "email": "johndoe@email.com",
    "salt": "da2b9a6e40220005234ce...d",
    "verifier": "48352c7435da05bf2c5bed4...2e",
	"serverEphemeralSecret":  "d7002b80ff50acd7556fa81..."
}
```
## Policies
### Default User Policy
```
{
    "Roles": {
        "User": {
            "permissions": [
                "EditProfile",
                "CreateWallet",
                "CheckBalance"
                // add as needed
            ]
        },
    },
}
```
### Admin Policy
```
{
    "Roles": {
        "Admin": {
            "permissions": [
                "ReadLogs",
                "ReadPersistenceTables",
                "CheckBalance",
                "UpdateConfig"
                // add as needed
            ]
        },
    },
}
```
### Support User Role
```
{
    systemWideUserId: systemWideUserId,
    role: "Support User Role",
    Permissions: []
};
```

### Password Policy
The password policy which will be read and enforced on the frontend during sign up and login is as follows:
```
{
    "password_policy_id": "default user",
    "expiresOn": <unixEpochMilli>
    "minLength": 8,
    "requireAlphanumeric": true,
    "allowUserDetails": false,
	// add as needed
}
```
This is stored in a dynamodb table with the following 'schema'
```
AWSTemplateFormatVersion: '2010-09-09'
Description: 'Creates the table will hold the password policy enforced during signup'
Resources:
 PasswordPolicyTable:
    Type: AWS::DynamoDB::Table
    Properties:
      TableName: "password_policy_table"
      AttributeDefinitions:
      -
        AttributeName: "password_policy_id"
        AttributeType: "S"
      -
        AttributeName: "last_updated_timestamp"
        AttributeType: "N"
      KeySchema:
      - AttributeName: "password_policy_id"
        KeyType: HASH
      - AttributeName: "last_updated_timestamp"
        KeyType: "RANGE"
      ProvisionedThroughput:
        ReadCapacityUnits: 2
        WriteCapacityUnits: 2
      PointInTimeRecoverySpecification:
        PointInTimeRecoveryEnabled: true

```


## Persistence
### Postgresql (RDS)
The data persisted during signup and used during login is stored in a postgresql database in a table with the following schema:
```
CREATE TABLE users (
  insertion_id SERIAL
  system_wide_user_id UUID PRIMARY KEY,
  salt TEXT,
  verifier TEXT,
  server_ephemeral_secret TEXT
  creation_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
  update_time TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```
This table also includes the following index:
```
CREATE INDEX idx_creation_time
ON users(creation_time)
```

## Authorization
### Basic Lmabda Authorizer
Access to most of the endpoints provided by this API is facilitated by way of a basic AWS lambda authorizer. This is merely a lambda called by API Gateway with the users token to confirm that the user has permission to perform the action they are requesting.The authorization lambda expects an event of the form:
```
{
    type: "TOKEN",
    authorizationToken: "Bearer eyJhbGciOiJSUzI...',
    methodArn: 'arn' // the name of the aws resource to be granted access to
}
```
If the token is valid the authorization lambda will return a JSON to API Gateway of the form
```
{
    principalId: '261ee5b1-88...',
    context: { 
        systemWideUserId: '21443071-e7d...',
        role: <requestedRole>,
        permissions: [ <associatedPermissions> ] 
    },
    policyDocument: { 
        Version: '2012-10-17', 
        Statement: [{
            Action: 'execute-api:Invoke',
            Effect: 'Allow',
            resource: 'arn'
        }]
    }
};
```
This will have the effect of directing API Gateway to grant the user access to the requested resources. It also provides the lambda services which constitute this API access to the users' role and permissions, making it easier to execute tasks as the token has already been decrypted.

If the token is invalid the authorization lambda will return
```
"Unauthorized"
```
This output is as expected by API Gateway and will have the effect of directing API Gateway to reject the users request and return an error message to the caller.


## Password Reset/Change

### Password Reset Lmabda

### Password Update Lambda