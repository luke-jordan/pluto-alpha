'use strict';

const config = require('config');
const logger = require('debug')('jupiter:migration:main');
const fs = require('fs');

const AWS = require('aws-sdk');
AWS.config.update({
  'region': config.get('aws.region')
});

const { Pool } = require('pg');
const pool = new Pool(config.get('db'));

const extractCommands = (pgResult) => {
  if (pgResult.length == 0) {
    return pgResult.command;
  } else {
    return pgResult.map((result) => result.command).join(', ');
  }
}

const runS3script = async (bucket, key) => {
  logger(`Fetching script from bucket ${bucket} and key ${key}`);

  const s3 = new AWS.S3();
  const params = {
    Bucket: scriptBucket,
    Key: scriptKey
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
}

const createDbRoles = async (credentialsDict) => {
  const rolesToCreate = Object.keys(credentialsDict);
  logger('Creating roles: ', rolesToCreate);
  
  const client = await pool.connect();
  try {
    for (let i = 0; i < rolesToCreate.length; i++) {
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
  const scripts = fs.readdirSync(scriptPath);
  logger('Result of script folder read: ', scripts);
  const client = await pool.connect();
  try {
    for (let i = 0; i < scripts.length; i++) {
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
  const typeOfExecution = event.type;
  logger('Executing migration of type: ', typeOfExecution);

  let result;
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
      input: event,
    }, null, 2),
  };

  // Use this code if you don't use the http event with the LAMBDA-PROXY integration
  // return { message: 'Go Serverless v1.0! Your function executed successfully!', event };
};
