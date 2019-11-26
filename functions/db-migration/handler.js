'use strict';

const config = require('config');
const logger = require('debug')('jupiter:migration:handler');
const {migrate} = require('postgres-migrations');
const AWS = require('aws-sdk');
const s3 = require('s3');
const httpStatus = require('http-status');

const awsRegion = config.get('aws.region');
AWS.config.update({
  'region': awsRegion
});
const migrationScriptsLocation = 'scripts';
const secretName = config.has('secrets.names.master') ? config.get(`secrets.names.master`) : null;
const secretsClient = new AWS.SecretsManager({ region: awsRegion });

const client = s3.createClient({
    s3Client: new AWS.S3()
});
const BUCKET_NAME = config.get('aws.bucketName');
const FOLDER_CONTAINING_MIGRATION_SCRIPTS = config.get('environment');


const fetchDBUsernameAndPasswordFromSecrets = async () => {
    logger('Fetching secret with name: ', secretName);

    return new Promise((resolve) => {
        secretsClient.getSecretValue({ 'SecretId': secretName }, (err, fetchedSecretData) => {
            if (err) {
                logger('Error retrieving auth secret for: ', err);
                throw err;
            }
            // Decrypts secret using the associated KMS CMK.
            // Depending on whether the secret is a string or binary, one of these fields will be populated.
            logger('No error, got the secret, moving onward: ', fetchedSecretData);
            const secret = JSON.parse(fetchedSecretData.SecretString);

            resolve({
                user: secret.username,
                password: secret.password
            });
        });
    });
};

const fetchDBConnectionDetails = async () => {
    logger('Fetching database connection details');
    const dbConfig = { ...config.get('db') };

    if (secretName) {
        const { user, password } = await fetchDBUsernameAndPasswordFromSecrets();
        if (user && password) {
            dbConfig.user = user;
            dbConfig.password = password;
        }
    }

    return dbConfig;
};

const runMigrations = (dbConfig) => {
  logger('Running Migrations');

  migrate({
    database: dbConfig.database,
    user: dbConfig.user,
    password: dbConfig.password,
    host: dbConfig.host,
    port: dbConfig.port
  }, migrationScriptsLocation).then(() => {
    logger('Migrations ran successfully');
  }).catch((error) => {
    logger(`Error occurred while running migrations. Error: ${JSON.stringify(error)}`);
    throw error;
  });
};

const handleFailureResponseOfDownloader = (error) => {
    logger('Error while downloading files from s3 bucket. Error stack:', error.stack);
    throw error;
};

const successfullyDownloadedFilesProceedToRunMigrations = async (dbConfig) => {
    logger(`Completed download of files from s3 bucket`);
    await runMigrations(dbConfig);
    return {
        statusCode: httpStatus.OK,
        body: JSON.stringify({
            message: 'Migrations ran successfully'
        })
    };
};

const handleProgressResponseOfDownloader = (progressAmount, progressTotal) => {
    logger(
        `Progress in downloading files from s3 bucket. Progress Amount: ${progressAmount}, Progress Total: ${progressTotal}`
    );
};

const downloadFilesFromS3AndRunMigrations = async (dbConfig) => {
    logger(
        `Fetching scripts from s3 bucket: ${BUCKET_NAME}/${FOLDER_CONTAINING_MIGRATION_SCRIPTS} to local directory: ${BUCKET_NAME}`
    );

    const params = {
        localDir: migrationScriptsLocation,
        s3Params: {
            Bucket: BUCKET_NAME,
            Prefix: FOLDER_CONTAINING_MIGRATION_SCRIPTS
        },
        deleteRemoved: true
    };

    const downloader = client.downloadDir(params);
    
    downloader.on('error', (err) => handleFailureResponseOfDownloader(err));
    downloader.on('progress', () => handleProgressResponseOfDownloader(downloader.progressAmount, downloader.progressTotal));
    downloader.on('end', () => successfullyDownloadedFilesProceedToRunMigrations(dbConfig));
};

module.exports.migrate = async () => {
  logger('Handling request to run migrations');
  try {
      const dbConfig = await fetchDBConnectionDetails();
      await downloadFilesFromS3AndRunMigrations(dbConfig);
  } catch (error) {
    logger(`Error occurred while handling request to run migrations. Error: ${JSON.stringify(error)}`);
      return {
          statusCode: httpStatus.INTERNAL_SERVER_ERROR,
          body: JSON.stringify({
              message: 'Error while handling request to run migrations'
          })
      };
  }
};


