'use strict';

const config = require('config');
const logger = require('debug')('jupiter:migration:main');
const fs = require('fs');

const AWS = require('aws-sdk');
AWS.config.update({
  'region': config.get('aws.region')
});

const { Pool } = require('pg');
let pool;

const initiateConnection = () => {
  const secretName = config.get(`secrets.names.${rdsUserName}`);
  logger('Fetching secret with name: ', secretName);

  const secretsMgmtEnabled = config.has('secrets.enabled') ? config.get('secrets.enabled') : false;
  
  if (secretsMgmtEnabled) {
    pool = new Pool(config.get('db'));
    return;
  }

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
      const dbConfig = config.get('db');
      dbConfig.user = secret.username;
      dbConfig.password = secret.password;
      
      pool = new Pool(dbConfig);
  });
};

const extractCommands = (pgResult) => {
  if (pgResult.length === 0) {
    return pgResult.command;
  } else if (Array.isArray(pgResult)) {
    return pgResult.map((result) => result.command).join(', ');
  }
  
  return pgResult;
};

const runS3script = async (bucket, key) => {
  logger(`Fetching script from bucket ${bucket} and key ${key}`);

  const s3 = new AWS.S3();
  const params = {
    Bucket: bucket,
    Key: key
  };

  const retrievalResult = await s3.getObject(params).promise();
  // logger('File object: ', retrievalResult);
  const sqlBody = retrievalResult.Body.toString('ascii');
  logger('Executing SQL script: \n', sqlBody);

  const queryResult = await pool.query(sqlBody);
  logger('Result of queries: ', queryResult);

  return 'S3SCRIPT_EXECUTED';
};

const executeRoleCreation = async (client, role, password) => {
  // note: Postgres has no 'if not exists' on create role but will skip the line if the role exists
  // note: if haven't switched to robust migration schema by then, put in 'if no exists' if/when Postgres allows it
  // note: using literal template here because offline and need to get this finished, never repeat
  // const result = await client.query('create role $1 with no superuser login password $2', [role, rolesToCreate[role]]);
  try {
    const queryString = `create role ${role} with nosuperuser login password '${password}'`;
    logger('Executing role creation query : ', queryString);
    const result = await client.query(queryString);
    logger('Result of query: ', result.command);
  } catch (e) {
    logger('Role creation failed: ', e.message);
  }
};

const createDbRoles = async (credentialsDict) => {
  const rolesToCreate = Object.keys(credentialsDict);
  logger('Creating roles: ', rolesToCreate);
  
  const client = await pool.connect();
  try {
    // note : we do this in the for loop so that failures eg on roles are contained
    for (let i = 0; i < rolesToCreate.length; i += 1) {
      const role = rolesToCreate[i];
      await executeRoleCreation(client, role, credentialsDict[role]);
    }
  } catch (e) {
    logger('Uncaught error: ', e);
  } finally {
    await client.release();
  }
  return 'EXECUTED';
};

const createInitialTables = async () => {
  const scriptPath = './tables';
  const scripts = fs.readdirSync(scriptPath).sort();
  logger('Result of script folder read: ', scripts);
  const client = await pool.connect();
  try {
    // we do this in a for loop as well as sequencing may matter
    for (let i = 0; i < scripts.length; i += 1) {
      const scriptName = scripts[i];
      logger('Executing: ', scriptName);
      const scriptContents = await fs.readFileSync(`${scriptPath}/${scriptName}`).toString();
      // logger('Contents of script: ', scriptContents);
      const result = await client.query(scriptContents);
      logger('Result of script execution: ', extractCommands(result));
    }
  } catch (e) {
    logger('Uncaught error: ', e);
  } finally {
    await client.release();
  }
};

module.exports.migrate = async (event) => {
  initiateConnection();

  const typeOfExecution = event.type;
  logger('Executing migration of type: ', typeOfExecution);

  while (!pool) {
      logger('No pool yet, waiting ...');
      await sleep(100);
  }

  let result = { };
  if (typeOfExecution === 'S3SCRIPT') {
    const scriptBucket = event.bucket;
    const scriptKey = event.key;
    result = await runS3script(scriptBucket, scriptKey);
  } else if (typeOfExecution === 'CREATE_ROLES') {
    result = await createDbRoles(event.credentials);
  } else if (typeOfExecution === 'SETUP_TABLES') {
    result = await createInitialTables();
  }
  
  // const objects = await s3.listObjects(params).promise();

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: result,
      input: event
    })
  };

  // Use this code if you don't use the http event with the LAMBDA-PROXY integration
  // return { message: 'Go Serverless v1.0! Your function executed successfully!', event };
};
