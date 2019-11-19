'use strict';

const config = require('config');
const logger = require('debug')('jupiter:migration:run_migrations');
const {migrate} = require('postgres-migrations');
const AWS = require('aws-sdk');

AWS.config.update({
  'region': config.get('aws.region')
});
const migrationScriptsLocation = 'scripts';
const secretName = config.get(`secrets.names.master`);
logger('Fetching secret with name: ', secretName);

let dbConfig;
const secretsClient = new AWS.SecretsManager({ region: config.get('aws.region') });        
secretsClient.getSecretValue({ 'SecretId': secretName }, (err, fetchedSecretData) => {
    if (err) {
        logger('Error retrieving auth secret for RDS: ', err);
        throw err;
    }
    // Decrypts secret using the associated KMS CMK.
    // Depending on whether the secret is a string or binary, one of these fields will be populated.
    logger('No error, got the secret, moving onward: ', fetchedSecretData);
    const secret = JSON.parse(fetchedSecretData.SecretString);
    dbConfig = { ...config.get('db') };
    dbConfig.user = secret.username;
    dbConfig.password = secret.password;
});

logger('running migrations');

// TODO:
// pass the db variables
// run on deploying the function
migrate({
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    host: dbConfig.host,
    port: dbConfig.port
  }, migrationScriptsLocation).
then(() => {
    logger('migrations ran successfully');
}).
catch((error) => {
  logger('Error occurred while running migrations: ', error);
});
