'use strict';

const config = require('config');
const moment = require('moment');
const uuid = require('uuid/v4');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

const helper = require('./test.helper');

const lamdbaInvokeStub = sinon.stub();
const publishEventStub = sinon.stub();
const getObjectStub = sinon.stub();
const uploadStub = sinon.stub();
const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub;
        this.upload = uploadStub;
    }
}

const handler = proxyquire('../admin-user-logging', {
    'publish-common': {
        'publishUserEvent': publishEventStub
    },
    'aws-sdk': {
        'Lambda': MockLambdaClient,
        'S3': MockS3Client
    },
    'moment': momentStub,
    '@noCallThru': true
});

const testSystemId = uuid();
const testAdminId = uuid();

const mockAttachment = 'JVBERi0xLjUKJdDUxdgKNiAwIG9iago8PAovTGVuZ3RoIDE5NTYgICAgICAKL0ZpbHRlci...';


describe('*** UNIT TEST ADMIN USER LOGGING ***', () => {
    beforeEach(() => {
        helper.resetStubs(publishEventStub);
    });
   
    it('Writes user log', async () => {
        const expectedResult = { publishResult: { result: 'SUCCESS' }};

        const expectedPublishOptions = {
            initiator: testAdminId,
            context: {
                systemWideUserId: testSystemId,
                note: 'User has proved their identity.',
                binaryS3Key: `${testSystemId}/user_documents.pdf`
            }
        };

        publishEventStub.resolves({ result: 'SUCCESS' });

        const eventBody = {
            systemWideUserId: testSystemId,
            eventType: 'VERIFIED_AS_PERSON',
            note: 'User has proved their identity.',
            binaryS3Key: `${testSystemId}/user_documents.pdf`
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfLog = await handler.writeLog(testEvent);

        expect(resultOfLog).to.exist;
        expect(resultOfLog).to.have.property('statusCode', 200);
        expect(resultOfLog.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfLog.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(publishEventStub).to.have.been.calledOnceWithExactly(testSystemId, 'VERIFIED_AS_PERSON', expectedPublishOptions);
    });

    // unhappy paths included to improve branch coverage
    it('Fails on unauthorized user', async () => {
        const resultOfLog = await handler.writeLog({});
        expect(resultOfLog).to.exist;
        expect(resultOfLog).to.have.property('statusCode', 403);
        expect(resultOfLog.headers).to.deep.equal(helper.expectedHeaders);
        expect(publishEventStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        publishEventStub.throws(new Error('Error! Something went wrong.'));

        const eventBody = {
            systemWideUserId: testSystemId,
            eventType: 'VERIFIED_AS_PERSON',
            note: 'User has proved their identity.',
            binaryS3Key: `${testSystemId}/user_documents.pdf`
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfLog = await handler.writeLog(testEvent);
        expect(resultOfLog).to.exist;
        expect(resultOfLog).to.have.property('statusCode', 500);
        expect(resultOfLog.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfLog.body).to.deep.equal(JSON.stringify('Error! Something went wrong.'));
    });
});

describe('*** UNIT TEST FETCH USER LOGS ***', () => {
    const testTimestamp = moment().subtract(5, 'days').valueOf();
    const testEndDate = moment().valueOf();

    beforeEach(() => {
        helper.resetStubs(lamdbaInvokeStub, getObjectStub);
    });
  
    it('Fetches user log', async () => {
        const testContext = {
            systemWideUserId: testSystemId,
            note: 'User has proved their identity.',
            binaryS3Key: `${testSystemId}/user_documents.pdf`
        };

        const expectedResult = [{
            initiator: 'USER',
            context: JSON.stringify(testContext),
            interface: 'MOBILE_APP',
            timestamp: testTimestamp,
            userId: testSystemId,
            eventType: 'VERIFIED_AS_PERSON',
            binaryFile: mockAttachment
        }];

        const expectedLogFromLambda = {
            StatusCode: 200,
            Payload: JSON.stringify({
                result: 'success',
                userEvents: {
                    totalCount: 1,
                    userEvents: [{
                        initiator: 'USER',
                        context: JSON.stringify(testContext),
                        interface: 'MOBILE_APP',
                        timestamp: testTimestamp,
                        userId: testSystemId,
                        eventType: 'VERIFIED_AS_PERSON'
                    }]
                }
            })
        };

        const expectedLogPayload = {
            endDate: testEndDate,
            eventTypes: ['VERIFIED_AS_PERSON'],
            startDate: testTimestamp,
            userId: testSystemId
        };

        const expectedS3Params = {
            Bucket: config.get('s3.binaries.bucket'),
            Key: `${testSystemId}/user_documents.pdf`
        };

        lamdbaInvokeStub.returns({ promise: () => expectedLogFromLambda });
        getObjectStub.returns({ promise: () => ({ Body: { toString: () => mockAttachment }}) });
        momentStub.returns({ valueOf: () => testEndDate });

        const eventBody = {
            systemWideUserId: testSystemId,
            eventType: 'VERIFIED_AS_PERSON',
            timestamp: testTimestamp
        };

        const testEvent = helper.wrapQueryParamEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const userLog = await handler.fetchLog(testEvent);

        expect(userLog).to.exist;
        expect(userLog).to.have.property('statusCode', 200);
        expect(userLog.headers).to.deep.equal(helper.expectedHeaders);
        expect(userLog.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(lamdbaInvokeStub).to.have.been.calledOnceWithExactly(helper.wrapLambdaInvoc(config.get('lambdas.userHistory'), false, expectedLogPayload));
        expect(getObjectStub).to.have.been.calledOnceWithExactly(expectedS3Params);
    });

    it('Fails on unauthorized user', async () => {
        const resultOfFetch = await handler.fetchLog({});
        expect(resultOfFetch).to.exist;
        expect(resultOfFetch).to.have.property('statusCode', 403);
        expect(resultOfFetch.headers).to.deep.equal(helper.expectedHeaders);
        expect(lamdbaInvokeStub).to.have.not.been.called;
        expect(getObjectStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        lamdbaInvokeStub.throws(new Error('Error! Something went wrong.'));
        momentStub.returns({ valueOf: () => testEndDate });

        const eventBody = {
            systemWideUserId: testSystemId,
            eventType: 'VERIFIED_AS_PERSON',
            timestamp: testTimestamp
        };

        const testEvent = helper.wrapQueryParamEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const userLog = await handler.fetchLog(testEvent);

        expect(userLog).to.exist;
        expect(userLog).to.have.property('statusCode', 500);
        expect(userLog.headers).to.deep.equal(helper.expectedHeaders);
        expect(userLog.body).to.deep.equal(JSON.stringify('Error! Something went wrong.'));
    });
});

describe('*** UNIT TEST UPLOAD LOG ATTACHMENTS ***', () => {
    beforeEach(() => {
        helper.resetStubs(uploadStub);
    });
   
    it('Uploads user log attachments', async () => {
        const expectedResult = { binaryS3Key: `${testSystemId}/user_documents.pdf` };

        const expectedUploadArgs = {
            Bucket: config.get('s3.binaries.bucket'),
            Key: `${testSystemId}/user_documents.pdf`,
            Body: Buffer.from(mockAttachment, 'base64')
        };

        const testUploadResult = { Location: `${testSystemId}/user_documents.pdf` };
        uploadStub.returns({ promise: () => testUploadResult });

        const eventBody = {
            systemWideUserId: testSystemId,
            binaryFile: {
                fileName: 'user_documents.pdf',
                fileContent: mockAttachment
            }
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfUpload = await handler.uploadLogBinary(testEvent);

        expect(resultOfUpload).to.exist;
        expect(resultOfUpload).to.have.property('statusCode', 200);
        expect(resultOfUpload.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfUpload.body).to.deep.equal(JSON.stringify(expectedResult));
        expect(uploadStub).to.have.been.calledOnceWithExactly(expectedUploadArgs);
    });

    it('Fails on unauthorized user', async () => {
        const resultOfUpload = await handler.uploadLogBinary({});
        expect(resultOfUpload).to.exist;
        expect(resultOfUpload).to.have.property('statusCode', 403);
        expect(resultOfUpload.headers).to.deep.equal(helper.expectedHeaders);
        expect(uploadStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        uploadStub.throws(new Error('Error! Something went wrong.'));

        const eventBody = {
            systemWideUserId: testSystemId,
            binaryFile: {
                fileName: 'user_documents.pdf',
                fileContent: mockAttachment
            }
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfUpload = await handler.uploadLogBinary(testEvent);

        expect(resultOfUpload).to.exist;
        expect(resultOfUpload).to.have.property('statusCode', 500);
        expect(resultOfUpload.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfUpload.body).to.deep.equal(JSON.stringify('Error! Something went wrong.'));
    });
});
