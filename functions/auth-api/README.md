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


## General Sign up Flow (SRP)
* User enters thier username and password into sign up form. The user is assigned a system wide user id and this together with the password is then passed to the Auth API's sign up lambda function. The event required by the sign up lambda is of the form:
```
{
    "systemWideUserId": "4579c88b-798f-42a8-a851-d80e38e19e3a",
    "password": "someP0licyC0mpliantPassw0rd"
}
```
* The lambda then converts this to an object of the form
```
{
    "systemWideUserId": "4579c88b-798f-42a8-a851-d80e38e19e3a",
    "salt": "da2b9a6e402200052...d",
    "verifier": "48352c7435da05bf2c5b...2"
}
```
* This new object is then sent to the server to be persisted.
* The Auth API upon successfuly storing the data will then send back details of its operations and a JSON Web Token if it's operations were successful. On success the lambda will return an object of the form:
```
{
    "message": "success",
    "jwt": "eyJhbGciCiJIBzI1NiI...JG"
}
```

* This conludes the current sign up operations relating to the Auth API

## General Login Flow (SRP)
* As during sign up, user enters username and password into login form. After login details are processed by an intermediary, the Auth API's login lambda recieves an event of the form
```
{
    "systemWideUserId": "4579c88b-798f-42a8-a851-d80e38e19e3a",
    "password": "someP0licyC0mpliantPassw0rd"
}
```
* You may note that this event is identical to that recieved during sign up.
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
                "CheckBalance"
                // add as needed
            ]
        },
    },
}
```
### Password Policy
The password policy which will be read and enforced on the frontend during sign up and login is as follows:
```
{
    "policyId": "default user",
    "expiresOn": <unixEpochMilli>
    "minLength": 8,
    "requireAlphanumeric": true,
    "allowUserDetails": false,
	// add as needed
}
```

## Persistence
### Postgresql (RDS)
The data persisted during signup and used during login is stored in a postgresql database in a table with the following schema:
```
CREATE TABLE users (
  insertion_id SERIAL
  system_wide_user_id TEXT PRIMARY KEY,
  salt TEXT,
  verifier TEXT,
  server_ephemeral_secret TEXT
  created_at TIMESTAMP
);
```
