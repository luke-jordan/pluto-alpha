'use strict';

const chai = require('chai');
const expect = chai.expect;
const sinon = require('sinon');
chai.use(require('sinon-chai'));

const migrationScript = require('../handler');
const {
    migrate,
    fetchDBConnectionDetails,
    downloadFilesFromS3AndRunMigrations
} = migrationScript;


const config = require('config');
const httpStatus = require('http-status');

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

        expect(result).to.exist;
        expect(result).to.deep.equal(sampleSuccessResponse);

        // expect stubs to have been called with arguments and in order
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

    // test fetchDBConnectionDetails without passing in secretName
    it(`should fetch db connection details when 'secretName' is 'undefined'`, async () => {
        const result = await fetchDBConnectionDetails();
        expect(result).to.exist;
        expect(result).to.deep.equal(sampleDbConfig);
    });

    // test fetchDBConnectionDetails while passing in secretName
    it(`should fetch db connection details when 'secretName' exists`, async () => {
       fetchDBUserAndPasswordFromSecretsStub.withArgs(sampleSecretName).resolves(sampleUserAndPasswordFromSecrets);
       
       const result = await fetchDBConnectionDetails(sampleSecretName);
       expect(result).to.exist;
       expect(result).to.deep.equal({ ...sampleDbConfig, ...sampleUserAndPasswordFromSecrets });
       expect(fetchDBUserAndPasswordFromSecretsStub).to.have.been.calledWith(sampleSecretName);
    });

    // test downloadFilesFromS3AndRunMigrations
    it(`should download files from the amazon s3 bucket`, async () => {

        // await downloadFilesFromS3AndRunMigrations(sampleDbConfig);
        
    })


    // test successfullyDownloadedFilesProceedToRunMigrations

    // test run migrations

    // test handleDBConfigUsingSecrets

    // test updateDBConfigUserAndPassword
});
