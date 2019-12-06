'use strict';

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
chai.use(require('sinon-chai'));
const proxyquire = require('proxyquire').noCallThru();
const config = require('config');
const httpStatus = require('http-status');
const EventEmitter = require('events').EventEmitter;
const AWS = require('aws-sdk');
const AWSMock = require('aws-sdk-mock');

const BUCKET_NAME = config.get('s3.bucket');
const FOLDER_CONTAINING_MIGRATION_SCRIPTS = config.get('s3.folder');

const actualMigrationStub = sinon.stub();
const downloadDirStub = sinon.stub();
const MockPostgresMigrations = {
    migrate: actualMigrationStub
};
const MockCustomS3Client = {
    createClient: () => ({
        'downloadDir': downloadDirStub
    })
};
const migrationScript = proxyquire('../handler', {
    'postgres-migrations': MockPostgresMigrations,
    's3': MockCustomS3Client
});

const fs = require('fs');
const fsReadDirStub = sinon.stub(fs, 'readdir');

const {
    migrate,
    fetchDBConnectionDetails,
    successfullyDownloadedFilesProceedToRunMigrations,
    handleFailureResponseOfDownloader,
    handleProgressResponseOfDownloader,
    updateDBConfigUserAndPassword,
    downloadFilesFromS3AndRunMigrations,
    fetchDBUserAndPasswordFromSecrets,
    runMigrations
} = migrationScript;

const fetchDBConnectionDetailsStub = sinon.stub(migrationScript, 'fetchDBConnectionDetails');
const downloadFilesFromS3AndRunMigrationsStub = sinon.stub(migrationScript, 'downloadFilesFromS3AndRunMigrations');
const fetchDBUserAndPasswordFromSecretsStub = sinon.stub(migrationScript, 'fetchDBUserAndPasswordFromSecrets');

const sampleSecretName = 'staging/test/psql/hello';
const sampleDbConfig = { ...config.get('db') };
const sampleSuccessResponse = {
    statusCode: httpStatus.OK,
    body: JSON.stringify({
        message: 'Migrations ran successfully'
    })
};
const sampleErrorResponse = {
    statusCode: httpStatus.INTERNAL_SERVER_ERROR,
    body: JSON.stringify({
        message: 'Error while handling request to run migrations'
    })
};
const sampleUserAndPasswordFromSecrets = {
    user: 'admin',
    password: 'password'
};
const migrationScriptsLocation = config.get('scripts.location');
const DOWNLOAD_PARAMS = {
    localDir: migrationScriptsLocation,
    s3Params: {
        Bucket: BUCKET_NAME,
        Prefix: FOLDER_CONTAINING_MIGRATION_SCRIPTS
    },
    deleteRemoved: true
};
const resetStubs = () => {
    fetchDBConnectionDetailsStub.reset();
    downloadFilesFromS3AndRunMigrationsStub.reset();
    fetchDBUserAndPasswordFromSecretsStub.reset();
};

describe('DB Migration', () => {
    beforeEach(() => {
        resetStubs();
    });

    it('should handle migrations request successfully', async () => {
        fetchDBConnectionDetailsStub.withArgs().resolves(sampleDbConfig);
        downloadFilesFromS3AndRunMigrationsStub.withArgs(sampleDbConfig).resolves(sampleSuccessResponse);

        const result = await migrate();

        expect(result).to.be.exist;
        expect(result).to.deep.equal(sampleSuccessResponse);

        expect(fetchDBConnectionDetailsStub).to.have.been.calledWith();
        expect(downloadFilesFromS3AndRunMigrationsStub).to.have.been.calledWith(sampleDbConfig);

        sinon.assert.callOrder(fetchDBConnectionDetailsStub, downloadFilesFromS3AndRunMigrationsStub);
    });

    it('should handle errors on a migration request', async () => {
        fetchDBConnectionDetailsStub.withArgs().throws('Error here');

        const result = await migrate();

        expect(result).to.exist;
        expect(result).to.deep.equal(sampleErrorResponse);

        expect(fetchDBConnectionDetailsStub).to.have.been.calledWith();
    });

    it(`should fetch db connection details when 'secretName' is 'undefined'`, async () => {
        const result = await fetchDBConnectionDetails();
        expect(result).to.exist;
        expect(result).to.deep.equal(sampleDbConfig);
    });

    it(`should fetch db connection details when 'secretName' exists works correctly`, async () => {
        fetchDBUserAndPasswordFromSecretsStub.withArgs(sampleSecretName).resolves(sampleUserAndPasswordFromSecrets);

        const result = await fetchDBConnectionDetails(sampleSecretName);
        expect(result).to.exist;
        expect(result).to.deep.equal({...sampleDbConfig, ...sampleUserAndPasswordFromSecrets});
        expect(fetchDBUserAndPasswordFromSecretsStub).to.have.been.calledWith(sampleSecretName);
    });

    it(`should fetch db connection details when 'secretName' exists but 'user' and 'password' not found`, async () => {
        fetchDBUserAndPasswordFromSecretsStub.withArgs(sampleSecretName).resolves({});

        const result = await fetchDBConnectionDetails(sampleSecretName);
        expect(result).to.exist;
        expect(result).to.deep.equal(sampleDbConfig);
        expect(fetchDBUserAndPasswordFromSecretsStub).to.have.been.calledWith(sampleSecretName);
    });

    it(`should run migrations successfully`, async () => {
        actualMigrationStub.withArgs(sampleDbConfig, migrationScriptsLocation).resolves();
        const result = await new Promise((resolve, reject) => runMigrations(sampleDbConfig, resolve, reject));
        expect(result).to.exist;
        expect(result).to.deep.equal(sampleSuccessResponse);
        expect(actualMigrationStub).to.have.been.calledWith(sampleDbConfig, migrationScriptsLocation);
    });

    it(`handle progress response of downloader should return undefined`, async () => {
        const result = await handleProgressResponseOfDownloader();
        expect(result).to.be.undefined;
    });

    it(`handle failure response of downloader throws an error`, async () => {
        const errorMessage = 'error during download';
        try {
            await new Promise((resolve, reject) => handleFailureResponseOfDownloader(errorMessage, reject));
        } catch (error) {
            expect(error).to.exist;
            expect(error).to.equal(errorMessage);
        }
    });

    it(`should update the database config when given the 'user' and 'password'`, async () => {
        const sampleUser = 'harry';
        const samplePassword = 'potter';
        const result = await updateDBConfigUserAndPassword(sampleDbConfig, sampleUser, samplePassword);

        expect(result).to.exist;
        expect(result).to.deep.equal({...sampleDbConfig, user: sampleUser, password: samplePassword});
    });

    it('download files from s3 when called with appropriate parameters involves an event emitter', async () => {
        const emitter = new EventEmitter();

        downloadDirStub.withArgs(DOWNLOAD_PARAMS).returns(emitter);
        const result = downloadFilesFromS3AndRunMigrations(sampleDbConfig);
        expect(result).to.exist;
        expect(downloadDirStub).to.have.been.calledWith(DOWNLOAD_PARAMS);
    });

    it(`should handle errors when 'migrate' method from 'postgres-migrations' fails`, async () => {
        const customErrorMessage = new Error('Error while running migrations');
        actualMigrationStub.withArgs(sampleDbConfig, migrationScriptsLocation).rejects(customErrorMessage);
        try {
            await new Promise((resolve, reject) => runMigrations(sampleDbConfig, resolve, reject));
        } catch (error) {
            expect(error).equal(customErrorMessage);
        }

        expect(actualMigrationStub).to.have.been.calledWith(sampleDbConfig, migrationScriptsLocation);
    });

    it(`should fetch secrets data using secrets client successfully`, async () => {
        const givenUser = 'john';
        const givenPassword = 'password';
        const JSONParsableUserNameAndPassword = `{
            "username": "${givenUser}",
            "password": "${givenPassword}"
            }`;

        const sampleFetchedSecretData = {
            SecretString: JSONParsableUserNameAndPassword
        };
        AWSMock.setSDKInstance(AWS);
        AWSMock.mock('SecretsManager', 'getSecretValue', (params, callback) => {
            callback(null, sampleFetchedSecretData);
        });

        const result = await fetchDBUserAndPasswordFromSecrets(sampleSecretName);
        expect(result).to.exist;
        expect(result).to.deep.equal({
            user: givenUser,
            password: givenPassword
        });
        AWSMock.restore('SecretsManager');
    });

    it(`should handle errors when fetching secrets data using secrets client`, async () => {
        const givenUser = 'john';
        const givenPassword = 'password';
        const JSONParsableUserNameAndPassword = `{
            "username": "${givenUser}",
            "password": "${givenPassword}"
            }`;

        const sampleFetchedSecretData = {
            SecretString: JSONParsableUserNameAndPassword
        };
        const customErrorMessage = 'Error while retrieving secret data';
        AWSMock.setSDKInstance(AWS);
        AWSMock.mock('SecretsManager', 'getSecretValue', (params, callback) => {
            callback(customErrorMessage, sampleFetchedSecretData);
        });

        try {
            await fetchDBUserAndPasswordFromSecrets(sampleSecretName);
        } catch (error) {
            expect(error).to.exist;
            expect(error).to.equal(customErrorMessage);
        }

        AWSMock.restore('SecretsManager');
    });
});
