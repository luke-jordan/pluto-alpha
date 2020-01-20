'use strict';

// const logger = require('debug')('jupiter:third-parties:sendgrid-unit-test');
const config = require('config');

const sinon = require('sinon');
const proxyquire = require('proxyquire');
const chai = require('chai');
chai.use(require('sinon-chai'));
chai.use(require('chai-as-promised'));
const expect = chai.expect;

const sendGridStub = sinon.stub();
const setApiKeyStub = sinon.stub();
const setSubstitutionsStub = sinon.stub();
const getObjectStub = sinon.stub();

class MockS3Client {
    constructor () { 
        this.getObject = getObjectStub;
    }
}

const handler = proxyquire('../email-handler', {
    'aws-sdk': { 'S3': MockS3Client },
    '@sendgrid/mail': {
        'send': sendGridStub,
        'setApiKey': setApiKeyStub,
        'setSubstitutionWrappers': setSubstitutionsStub
    }
});

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

describe('*** UNIT TEST SENDGRID EMAIL DISPATCHING FROM REMOTE TEMPLATE ***', () => {

    const testUserName = 'Jane';
    const testEmailAddress = 'jane@email.com';
    const validSubject = 'Welcome to Jupiter';

    const validHtmlTemplate = '<p>Greetings {{user}}, \nWelcome to Jupiter.</p>';
    const validTextTemplate = 'Greetings {{user}}. \nWelcome to Jupiter.';

    const testTemplateBucket = 'templateBucket';
    const testTemplateKey = 'templateKey';

    const testDestinationDetails = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
    const validPersonalization = {
        'to': [{ 'email': testEmailAddress }],
        'substitutions': { user: testUserName, subject: validSubject }
    };

    const validAssembledEmail = {
        'from': { 'email': config.get('sendgrid.fromAddress'), 'name': 'Jupiter' },
        'reply_to': { 'email': config.get('sendgrid.replyToAddress'), 'name': 'Jupiter' },
        'subject': '{{subject}}',
        'content': [
            { 'type': 'text/plain', 'value': validTextTemplate },
            { 'type': 'text/html', 'value': validHtmlTemplate }
        ],
        'mail_settings': {
            'sandbox_mode': { 'enable': config.get('sendgrid.sandbox') }
        },
        'personalizations': [validPersonalization]
    };

    const formatError = (errorMessage) => ({ result: 'ERR', message: errorMessage });
     
    beforeEach(() => {
        setApiKeyStub.resolves();
        resetStubs(sendGridStub, getObjectStub);
    });

    it('Handles warm up event', async () => {
        const resultOfEmail = await handler.sendEmailsFromSource({ });
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'Empty invocation' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });
    
    it('Handles single email', async () => {
        const testDestinationArray = [testDestinationDetails];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendGridStub.resolves([{ statusCode: 202, statusMessage: 'Accepted' }]);

        const testEvent = {
            templates: {
                templateKeyBucket: { key: testTemplateKey, bucket: testTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendGridStub).to.have.been.calledOnceWithExactly(validAssembledEmail);
    });

    it('Handles multiple emails', async () => {
        const expectedAssembledEmail = { ...validAssembledEmail };
        expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization, validPersonalization]; 
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templates: {
                templateKeyBucket: { key: testTemplateKey, bucket: testTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedAssembledEmail);
    });

    it('Handles chunking of payloads where target email addresses exceed third party rate limit', async () => {
        const testDestinationArray = [];
        while (testDestinationArray.length < 2500) {
            testDestinationArray.push(testDestinationDetails);
        }

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templates: {
                templateKeyBucket: { key: testTemplateKey, bucket: testTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendGridStub).to.have.been.calledThrice;

        const firstCall = sendGridStub.getCall(0).args[0];
        expect(firstCall.personalizations.length).to.equal(1000);

        const secondCall = sendGridStub.getCall(1).args[0];
        expect(secondCall.personalizations.length).to.equal(1000);

        const thirdCall = sendGridStub.getCall(2).args[0];
        expect(thirdCall.personalizations.length).to.equal(500);
    });

    // it('Handles attachments', async () => {

    // });

    // it('Fails on unsupported or invalid attachment', async () => {

    // });

    it('Fails on invalid method parameters', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templates: {
                templateKeyBucket: { key: testTemplateKey, bucket: testTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        Reflect.deleteProperty(testEvent, 'subject');
        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Missing email subject'));

        testEvent.subject = validSubject;

        Reflect.deleteProperty(testEvent.templates, 'templateKeyBucket');
        Reflect.deleteProperty(testEvent.templates, 'textTemplate');

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Missing required html template'));

        testEvent.templates.templateKeyBucket = { bucket: testTemplateBucket };

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Missing valid template key-bucket pair'));

        testEvent.templates.templateKeyBucket = { key: testTemplateKey, bucket: testTemplateBucket };

        Reflect.deleteProperty(testEvent, 'destinationArray');

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Missing destination array'));

        testEvent.destinationArray = [{}, {}];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);
        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('No valid destinations found'));

        testEvent.destinationArray = [{ someOtherKey: 'that should not exist' }];
        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('No valid destinations found'));
 
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

    it('Fails on malformed assembled email', async () => {
        const testDestinationArray = [testDestinationDetails];
    
        const testEvent = {
            templates: {
                templateKeyBucket: { key: testTemplateKey, bucket: testTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => '' }})});

        Reflect.deleteProperty(testEvent.templates, 'textTemplate');

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('You must provide either a text or html template or both'));

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => ({ invalid: 'html template'}) }})});

        testEvent.templates.textTemplate = validTextTemplate;

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError(`Invalid HTML template: ${JSON.stringify({ invalid: 'html template'})}`));

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});

        testEvent.templates.textTemplate = { invalid: 'text template'};

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError(`Invalid text template: ${JSON.stringify({ invalid: 'text template'})}`));

        expect(getObjectStub).to.have.been.calledWith({ Bucket: testTemplateBucket, Key: testTemplateKey });
        expect(sendGridStub).to.have.not.been.called;
    });
});

describe('*** UNIT TEST SENDGRID EMAIL DISPATCH FROM LOCAL TEMPLATE ***', () => {

    const testUserName = 'John';
    const testEmailAddress = 'john@email.com';
    const validSubject = 'Welcome to Jupiter';

    const validHtmlTemplate = '<p>Greetings {{user}}, \nWelcome to Jupiter.</p>';
    const validTextTemplate = 'Greetings {{user}}. \nWelcome to Jupiter.';

    const testDestinationDetails = { emailAddress: testEmailAddress, templateVariables: { user: testUserName }};
    const validPersonalization = {
        'to': [{ 'email': testEmailAddress }],
        'substitutions': { user: testUserName, subject: validSubject }
    };

    const validAssembledEmail = {
        'from': { 'email': config.get('sendgrid.fromAddress'), 'name': 'Jupiter' },
        'reply_to': { 'email': config.get('sendgrid.replyToAddress'), 'name': 'Jupiter' },
        'subject': '{{subject}}',
        'content': [
            { 'type': 'text/plain', 'value': validTextTemplate },
            { 'type': 'text/html', 'value': validHtmlTemplate }
        ],
        'mail_settings': {
            'sandbox_mode': { 'enable': config.get('sendgrid.sandbox') }
        },
        'personalizations': [validPersonalization]
    };

    const formatError = (errorMessage) => ({ result: 'ERR', message: errorMessage });

    beforeEach(() => {
        setApiKeyStub.resolves();
        resetStubs(sendGridStub, getObjectStub);
    });

    it('Handles warm up event', async () => {
        const resultOfEmail = await handler.sendEmails({ });
        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'Empty invocation' });
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });
    
    it('Sends single email', async () => {
        const testDestinationArray = [testDestinationDetails];

        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templates: {
                htmlTemplate: validHtmlTemplate,
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmails(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.been.calledOnceWithExactly(validAssembledEmail);
    });

    it('Handles multiple emails', async () => {
        const expectedAssembledEmail = { ...validAssembledEmail };
        expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization, validPersonalization]; 
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templates: {
                htmlTemplate: validHtmlTemplate,
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmails(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedAssembledEmail);
    });

    it('Handles chunking of payloads where target email addresses exceed third party rate limit', async () => {
        const testDestinationArray = [];
        while (testDestinationArray.length < 2500) {
            testDestinationArray.push(testDestinationDetails);
        }

        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templates: {
                htmlTemplate: validHtmlTemplate,
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmails(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.been.calledThrice;

        const firstCall = sendGridStub.getCall(0).args[0];
        expect(firstCall.personalizations.length).to.equal(1000);

        const secondCall = sendGridStub.getCall(1).args[0];
        expect(secondCall.personalizations.length).to.equal(1000);

        const thirdCall = sendGridStub.getCall(2).args[0];
        expect(thirdCall.personalizations.length).to.equal(500);
    });

    // it('Handles attachments', async () => {

    // });

    // it('Fails on unsupported or invalid attachment', async () => {

    // });

    it('Fails on invalid method parameters', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templates: {
                htmlTemplate: validHtmlTemplate,
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        Reflect.deleteProperty(testEvent, 'subject');

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('Missing email subject'));

        testEvent.subject = validSubject;

        Reflect.deleteProperty(testEvent.templates, 'htmlTemplate');
        Reflect.deleteProperty(testEvent.templates, 'textTemplate');

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('Missing required html template'));

        testEvent.templates.htmlTemplate = validHtmlTemplate;

        Reflect.deleteProperty(testEvent, 'destinationArray');

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('Missing destination array'));

        testEvent.destinationArray = [{}, {}];

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('No valid destinations found'));

        testEvent.destinationArray = [{ someOtherKey: 'that should not exist' }];

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError('No valid destinations found'));
 
        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

    it('Fails on malformed assembled email', async () => {
        const testDestinationArray = [testDestinationDetails];
    
        const testEvent = {
            templates: {
                htmlTemplate: validHtmlTemplate,
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        testEvent.templates.htmlTemplate = { invalid: 'html template' };
        testEvent.templates.textTemplate = validTextTemplate;

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError(`Invalid HTML template: ${JSON.stringify({ invalid: 'html template'})}`));

        testEvent.templates.htmlTemplate = validHtmlTemplate;
        testEvent.templates.textTemplate = { invalid: 'text template'};

        await expect(handler.sendEmails(testEvent)).to.eventually.deep.equal(formatError(`Invalid text template: ${JSON.stringify({ invalid: 'text template'})}`));

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });
});
