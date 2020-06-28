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
const putObjectStub = sinon.stub();

const momentStub = sinon.stub();

class MockLambdaClient {
    constructor () {
        this.invoke = lamdbaInvokeStub;
    }
}

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub;
        this.putObject = putObjectStub;
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
const mockBase64EncodedFile = 'JVBERi0xLjUKJdDUxdgKNiAwIG9iago8PAovTGVuZ3RoIDE5NTYgICAgICAKL0ZpbHRlci...';

// todo : move the below to admin.user.manage.unit.js
// describe('*** UNIT TEST ADMIN USER LOGGING ***', () => {
//     beforeEach(() => {
//         helper.resetStubs(publishEventStub);
//     });
   
//     it('Writes user log', async () => {
//         const expectedResult = { publishResult: { result: 'SUCCESS' }};

//         const expectedPublishOptions = {
//             initiator: testAdminId,
//             context: {
//                 systemWideUserId: testSystemId,
//                 note: 'User has proved their identity.',
//                 file: {
//                     filePath: `${testSystemId}/user_documents.pdf`
//                 }
//             }
//         };

//         publishEventStub.resolves({ result: 'SUCCESS' });

//         const eventBody = {
//             systemWideUserId: testSystemId,
//             eventType: 'VERIFIED_AS_PERSON',
//             note: 'User has proved their identity.',
//             file: {
//                 filePath: `${testSystemId}/user_documents.pdf`
//             }
//         };

//         const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
//         const resultOfLog = await handler.writeLog(testEvent);

//         expect(resultOfLog).to.exist;
//         expect(resultOfLog).to.have.property('statusCode', 200);
//         expect(resultOfLog.headers).to.deep.equal(helper.expectedHeaders);
//         expect(resultOfLog.body).to.deep.equal(JSON.stringify(expectedResult));
//         expect(publishEventStub).to.have.been.calledOnceWithExactly(testSystemId, 'VERIFIED_AS_PERSON', expectedPublishOptions);
//     });

//     // unhappy paths included to improve branch coverage
//     it('Fails on unauthorized user', async () => {
//         const resultOfLog = await handler.writeLog({});
//         expect(resultOfLog).to.exist;
//         expect(resultOfLog).to.have.property('statusCode', 403);
//         expect(resultOfLog.headers).to.deep.equal(helper.expectedHeaders);
//         expect(publishEventStub).to.have.not.been.called;
//     });

//     it('Catches thrown errors', async () => {
//         publishEventStub.throws(new Error('Error! Something went wrong.'));

//         const eventBody = {
//             systemWideUserId: testSystemId,
//             eventType: 'VERIFIED_AS_PERSON',
//             note: 'User has proved their identity.',
//             filePath: `${testSystemId}/user_documents.pdf`
//         };

//         const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
//         const resultOfLog = await handler.writeLog(testEvent);
//         expect(resultOfLog).to.exist;
//         expect(resultOfLog).to.have.property('statusCode', 500);
//         expect(resultOfLog.headers).to.deep.equal(helper.expectedHeaders);
//         expect(resultOfLog.body).to.deep.equal(JSON.stringify('Error! Something went wrong.'));
//     });
// });

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
            file: {
                filePath: `${testSystemId}/user_documents.pdf`
            }
        };

        const expectedResult = [{
            initiator: 'USER',
            context: JSON.stringify(testContext),
            interface: 'MOBILE_APP',
            timestamp: testTimestamp,
            userId: testSystemId,
            eventType: 'VERIFIED_AS_PERSON',
            file: mockBase64EncodedFile
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
            eventTypes: ['VERIFIED_AS_PERSON'],
            startDate: testTimestamp,
            endDate: testTimestamp + 1,
            userId: testSystemId
        };

        const expectedS3Params = {
            Bucket: config.get('binaries.s3.bucket'),
            Key: `${testSystemId}/user_documents.pdf`
        };

        lamdbaInvokeStub.returns({ promise: () => expectedLogFromLambda });
        getObjectStub.returns({ promise: () => ({ Body: { toString: () => mockBase64EncodedFile }}) });
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
        helper.resetStubs(putObjectStub);
    });
   
    it('Uploads user log attachments', async () => {
        const expectedResult = { result: 'UPLOADED', filePath: `${testSystemId}/user_documents.pdf` };

        putObjectStub.returns(({ promise: () => ({ })}));

        const eventBody = {
            systemWideUserId: testSystemId,
            file: {
                filename: 'user_documents.pdf',
                mimeType: 'application/pdf',
                fileContent: mockBase64EncodedFile
            }
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfUpload = await handler.uploadLogBinary(testEvent);

        const uploadResult = helper.standardOkayChecks(resultOfUpload, true);
        expect(uploadResult).to.deep.equal(expectedResult);

        const expectedS3Params = {
            Bucket: config.get('binaries.s3.bucket'),
            Key: `${testSystemId}/user_documents.pdf`,
            ContentType: 'application/pdf',
            Body: Buffer.from(mockBase64EncodedFile, 'base64')
        };

        expect(putObjectStub).to.have.been.calledOnceWithExactly(expectedS3Params);
    });

    it('Fails on unauthorized user', async () => {
        const resultOfUpload = await handler.uploadLogBinary({});
        expect(resultOfUpload).to.exist;
        expect(resultOfUpload).to.have.property('statusCode', 403);
        expect(resultOfUpload.headers).to.deep.equal(helper.expectedHeaders);
        expect(putObjectStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        putObjectStub.throws(Error('Error uploading file'));

        const eventBody = {
            systemWideUserId: testSystemId,
            file: {
                filename: 'user_documents.pdf',
                mimeType: 'application/pdf',
                fileContent: mockBase64EncodedFile
            }
        };

        const testEvent = helper.wrapEvent(eventBody, testAdminId, 'SYSTEM_ADMIN');
        const resultOfUpload = await handler.uploadLogBinary(testEvent);

        expect(resultOfUpload).to.exist;
        expect(resultOfUpload).to.have.property('statusCode', 500);
        expect(resultOfUpload.headers).to.deep.equal(helper.expectedHeaders);
        expect(resultOfUpload.body).to.deep.equal(JSON.stringify('Error uploading file'));
    });
});
