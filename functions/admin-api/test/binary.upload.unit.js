'use strict';

const config = require('config');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const putObjectStub = sinon.stub();

class MockS3Client {
    constructor () { 
        this.putObject = putObjectStub;
    }
}

const handler = proxyquire('../admin-user-logging', {
    'aws-sdk': { 'S3': MockS3Client },
    '@noCallThru': true
});

describe('*** UNIT TEST BINARY S3 STORAGE ***', () => {
    const testSystemId = uuid();
    const testAdminId = uuid();
    const mockBase64EncodedFile = 'XJ0eHJlZgo4MjU4NTYKJSVFT0YNCi0tLS0tLS0tLS0tLS0tLS ...';

    it('Stores binaries in s3 properly', async () => {
        const expectedResult = { filePath: `${testSystemId}/user_documents.pdf` };

        const expectedS3Params = {
            Bucket: config.get('binaries.s3.bucket'),
            Key: `${testSystemId}/user_documents.pdf`,
            ContentType: 'application/pdf',
            Body: Buffer.from(mockBase64EncodedFile, 'base64')
        };

        putObjectStub.returns({ promise: () => ({})});

        const eventParams = {
            userId: testSystemId,
            filename: 'user_documents.pdf',
            mimeType: 'application/pdf'
        };

        const testEvent = helper.wrapQueryParamEvent(eventParams, testAdminId, 'SYSTEM_ADMIN', 'POST');
        testEvent.content = mockBase64EncodedFile;

        const resultOfUpload = await handler.storeBinary(testEvent);
        expect(resultOfUpload).to.exist;
        expect(resultOfUpload).to.have.property('statusCode', 200);
        expect(resultOfUpload.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfUpload.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(putObjectStub).to.have.been.calledOnceWithExactly(expectedS3Params);
    });

    it('Catches thrown errors', async () => {
        putObjectStub.throws(new Error('Error storing binary'));

        const eventParams = {
            userId: testSystemId,
            filename: 'user_documents.pdf',
            mimeType: 'application/pdf'
        };

        const testEvent = helper.wrapQueryParamEvent(eventParams, testAdminId, 'SYSTEM_ADMIN', 'POST');
        testEvent.content = mockBase64EncodedFile;

        const resultOfUpload = await handler.storeBinary(testEvent);
        expect(resultOfUpload).to.exist;
        expect(resultOfUpload).to.have.property('statusCode', 500);
        expect(resultOfUpload.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfUpload.body).to.deep.equal(JSON.stringify('Error storing binary'));
    });
});
