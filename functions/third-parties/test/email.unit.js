'use strict';

// const logger = require('debug')('jupiter:third-parties:sendgrid-unit-test');
const config = require('config');
const uuid = require('uuid/v4');
const path = require('path');

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

const fetchAttachmentType = (fileExtension) => config.get('sendgrid.supportedAttachments')[fileExtension];

const resetStubs = (...stubs) => {
    stubs.forEach((stub) => stub.reset());
};

describe('*** UNIT TEST SENDGRID EMAIL DISPATCHING FROM REMOTE TEMPLATE ***', () => {

    const testUserName = 'FRTNX';
    const testEmailAddress = 'frtnx@protonmail.com';
    const validSubject = 'Welcome to Jupiter';

    const validHtmlTemplate = '<p>Greetings {{user}}, \nWelcome to Jupiter.</p>';
    const validTextTemplate = 'Greetings {{user}}. \nWelcome to Jupiter.';

    const mockTemplateBucket = 'templateBucket';
    const mockTemplateKey = 'templateKey';

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
            'sandbox_mode': { 'enable': true }
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
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: mockTemplateBucket, Key: mockTemplateKey });
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
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: mockTemplateBucket, Key: mockTemplateKey });
        expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedAssembledEmail);
    });

    it('Isolates invalid destination objects', async () => {
        const expectedAssembledEmail = { ...validAssembledEmail };
        expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization]; 
        const invalidDestinationDetails = [{ emailAddress: 'test@email.com', templateVariables: { }}, { templateVariables: { }}, { emailAddress: 'test2@email.com' }];
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, ...invalidDestinationDetails];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templates: {
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [
            { templateVariables: {} },
            { emailAddress: 'test2@email.com' },
            { emailAddress: 'test@email.com', templateVariables: {} }
        ]});

        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: mockTemplateBucket, Key: mockTemplateKey });
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
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: mockTemplateBucket, Key: mockTemplateKey });
        expect(sendGridStub).to.have.been.calledThrice;

        const firstCall = sendGridStub.getCall(0).args[0];
        expect(firstCall.personalizations.length).to.equal(1000);

        const secondCall = sendGridStub.getCall(1).args[0];
        expect(secondCall.personalizations.length).to.equal(1000);

        const thirdCall = sendGridStub.getCall(2).args[0];
        expect(thirdCall.personalizations.length).to.equal(500);
    });

    // it('Isolates failed chunks', async () => {

    // });

    it('Handles attachments', async () => {
        const mockAttachmentBucket = 'attachments';
        const mockAttachmentContent = 'T3VycyBpcyBhIHdvcmxkIG9mIG51Y2xlYXIgZ2lhbnRzIGFuZCBldGhpY2FsIGluZmFudHMuIFdlIGtub3cgbW9yZSBh' +
            'Ym91dCB3YXIgdGhhbiB3ZSBrbm93IGFib3V0IHBlYWNlLCBtb3JlIGFib3V0IGtpbGxpbmcgdGhhdCB3ZSBrbm93IGFib3V0IGxpdmluZy4=';

        const validAttachment = (filename) => ({
            content: mockAttachmentContent,
            filename,
            type: fetchAttachmentType(path.extname(filename)),
            disposition: 'attachment'
        });

        const expectedAssembledEmail = { ...validAssembledEmail };
        expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization, validPersonalization]; 
        expectedAssembledEmail.attachments = [validAttachment('attachment.pdf'), validAttachment('attachment.csv')];

        getObjectStub.withArgs({ Bucket: mockTemplateBucket, Key: mockTemplateKey }).returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        getObjectStub.returns({ promise: () => ({ Body: { toString: () => mockAttachmentContent }})});
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templates: {
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: [testDestinationDetails, testDestinationDetails, testDestinationDetails],
            attachments: [
                {
                    source: { key: 'attachement.pdf', bucket: mockAttachmentBucket },
                    filename: 'attachment.pdf'
                },
                {
                    source: { key: 'attachement.csv', bucket: mockAttachmentBucket },
                    filename: 'attachment.csv'
                }
            ]
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.been.calledThrice;
        expect(getObjectStub).to.have.been.calledWith({ Bucket: mockTemplateBucket, Key: mockTemplateKey });
        expect(getObjectStub).to.have.been.calledWith({ Bucket: mockAttachmentBucket, Key: 'attachement.pdf' });
        expect(getObjectStub).to.have.been.calledWith({ Bucket: mockAttachmentBucket, Key: 'attachement.csv' });
        expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedAssembledEmail);
    });

    it('Overwrites default fromName and replyToName values when provided in event', async () => {
        const mockAttachmentBucket = 'attachments';
        const mockAttachmentContent = 'TmF0dXJlIHdpbGwgYmVhciB0aGUgY2xvc2VzdCBpbnNwZWN0aW9uLiBTaGUgaW52aXRlcyB1cy' + 
            'B0byBsYXkgb3VyIGV5ZSBsZXZlbCB3aXRoIGhlciBzbWFsbGVzdCBsZWFmLCBhbmQgdGFrZSBhbiBpbnNlY3QgdmlldyBvZiBpdHMgcGxhaW4u';

        const validAttachment = (filename) => ({
            content: mockAttachmentContent,
            filename,
            type: 'application/pdf',
            disposition: 'attachment'
        });

        const expectedAssembledEmail = { ...validAssembledEmail };
        expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization, validPersonalization]; 
        expectedAssembledEmail.attachments = [validAttachment('attachment.pdf'), validAttachment('attachment2.pdf')];
        expectedAssembledEmail.from.name = 'Jupiter Admin';
        expectedAssembledEmail.reply_to.name = 'Jupiter Admin';

        getObjectStub.withArgs({ Bucket: mockTemplateBucket, Key: mockTemplateKey }).returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
        getObjectStub.returns({ promise: () => ({ Body: { toString: () => mockAttachmentContent }})});
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templates: {
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: [testDestinationDetails, testDestinationDetails, testDestinationDetails],
            sourceDetails: { fromName: 'Jupiter Admin', replyToName: 'Jupiter Admin' },
            attachments: [
                {
                    source: { key: 'attachement.pdf', bucket: mockAttachmentBucket },
                    filename: 'attachment.pdf'
                },
                {
                    source: { key: 'attachement2.pdf', bucket: mockAttachmentBucket },
                    filename: 'attachment2.pdf'
                }
            ]
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.been.calledThrice;
        expect(getObjectStub).to.have.been.calledWith({ Bucket: mockTemplateBucket, Key: mockTemplateKey });
        expect(getObjectStub).to.have.been.calledWith({ Bucket: mockAttachmentBucket, Key: 'attachement.pdf' });
        expect(getObjectStub).to.have.been.calledWith({ Bucket: mockAttachmentBucket, Key: 'attachement2.pdf' });
        expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedAssembledEmail);
    });

    it('Fails on unsupported or invalid attachment', async () => {
        const mockAttachmentBucket = 'attachments';
    
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templates: {
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray,
            attachments: [
                {
                    source: { key: 'attachement.js', bucket: mockAttachmentBucket },
                    filename: 'attachment.js'
                }
            ]
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'ERR', message: 'Unsupported attachment type: attachment.js' });

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

    it('Fails on missing attachment file name', async () => {
        const mockAttachmentBucket = 'attachments';
    
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templates: {
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray,
            attachments: [
                {
                    source: { key: 'attachement.jpeg', bucket: mockAttachmentBucket }
                }
            ]
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'ERR', message: 'Invalid attachment. Missing attachment filename' });

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

    it('Fails on missing or invalid attachment S3 key-bucket pair', async () => {
        const mockAttachmentBucket = 'attachments';
    
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templates: {
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray,
            attachments: [
                {
                    source: { bucket: mockAttachmentBucket },
                    filename: 'attachment.odt'
                }
            ]
        };

        const resultOfEmail = await handler.sendEmailsFromSource(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'ERR', message: 'Invalid attachment source' });

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

    it('Fails on invalid method parameters', async () => {
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templates: {
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
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

        testEvent.templates.templateKeyBucket = { bucket: mockTemplateBucket };

        await expect(handler.sendEmailsFromSource(testEvent)).to.eventually.deep.equal(formatError('Missing valid template key-bucket pair'));

        testEvent.templates.templateKeyBucket = { key: mockTemplateKey, bucket: mockTemplateBucket };

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
                templateKeyBucket: { key: mockTemplateKey, bucket: mockTemplateBucket },
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

        expect(getObjectStub).to.have.been.calledWith({ Bucket: mockTemplateBucket, Key: mockTemplateKey });
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
            'sandbox_mode': { 'enable': true }
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

    it('Isolates invalid destination objects', async () => {
        const expectedAssembledEmail = { ...validAssembledEmail };
        expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization]; 
        const invalidDestinationDetails = [{ emailAddress: 'test@email.com', templateVariables: { }}, { templateVariables: { }}, { emailAddress: 'test2@email.com' }];
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, ...invalidDestinationDetails];

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => validHtmlTemplate }})});
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
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [
            { templateVariables: {} },
            { emailAddress: 'test2@email.com' },
            { emailAddress: 'test@email.com', templateVariables: {} }
        ]});

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

    // it('Isolates failed chunks', async () => {

    // });

    it('Handles attachments', async () => {
        const mockAttachmentBucket = 'attachments';
        const mockAttachmentContent = 'SXQgaXMgbm90IGtub3dsZWRnZSwgYnV0IHRoZSBhY3Qgb2YgbGVhcm5pbmcsIG5vdCBwb3Nz' + 
            'ZXNzaW9uIGJ1dCB0aGUgYWN0IG9mIGdldHRpbmcgdGhlcmUsIHdoaWNoIGdyYW50cyB0aGUgZ3JlYXRlc3QgZW5qb3ltZW50Lg==';

            const validAttachment = (filename) => ({
                content: mockAttachmentContent,
                filename,
                type: 'application/pdf',
                disposition: 'attachment'
            });
    
            const expectedAssembledEmail = { ...validAssembledEmail };
            expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization, validPersonalization]; 
            expectedAssembledEmail.attachments = [validAttachment('attachment.pdf'), validAttachment('attachment2.pdf')];
    
            getObjectStub.returns({ promise: () => ({ Body: { toString: () => mockAttachmentContent }})});
            sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);
    
            const testEvent = {
                templates: {
                    htmlTemplate: validHtmlTemplate,
                    textTemplate: validTextTemplate
                },
                subject: validSubject,
                destinationArray: [testDestinationDetails, testDestinationDetails, testDestinationDetails],
                attachments: [
                    {
                        source: { key: 'attachement.pdf', bucket: mockAttachmentBucket },
                        filename: 'attachment.pdf'
                    },
                    {
                        source: { key: 'attachement2.pdf', bucket: mockAttachmentBucket },
                        filename: 'attachment2.pdf'
                    }
                ]
            };
    
            const resultOfEmail = await handler.sendEmails(testEvent);
    
            expect(resultOfEmail).to.exist;
            expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });
    
            expect(getObjectStub).to.have.been.calledTwice;
            expect(getObjectStub).to.have.been.calledWith({ Bucket: mockAttachmentBucket, Key: 'attachement.pdf' });
            expect(getObjectStub).to.have.been.calledWith({ Bucket: mockAttachmentBucket, Key: 'attachement2.pdf' });
            expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedAssembledEmail);
    });

    it('Overwrites default fromName and replyToName values when provided in event', async () => {
        const mockAttachmentBucket = 'attachments';
        const mockAttachmentContent = 'S25vd2xlZGdlIGlzIGxvdmUgYW5kIGxpZ2h0IGFuZCB2aXNpb24u';

        const validAttachment = (filename) => ({
            content: mockAttachmentContent,
            filename,
            type: 'application/pdf',
            disposition: 'attachment'
        });

        const expectedAssembledEmail = { ...validAssembledEmail };
        expectedAssembledEmail.personalizations = [validPersonalization, validPersonalization, validPersonalization]; 
        expectedAssembledEmail.attachments = [validAttachment('attachment.pdf'), validAttachment('attachment2.pdf')];
        expectedAssembledEmail.from.name = 'Jupiter Admin';
        expectedAssembledEmail.reply_to.name = 'Jupiter Admin';

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => mockAttachmentContent }})});
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const testEvent = {
            templates: {
                htmlTemplate: validHtmlTemplate,
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: [testDestinationDetails, testDestinationDetails, testDestinationDetails],
            sourceDetails: { fromName: 'Jupiter Admin', replyToName: 'Jupiter Admin' },
            attachments: [
                {
                    source: { key: 'attachement.pdf', bucket: mockAttachmentBucket },
                    filename: 'attachment.pdf'
                },
                {
                    source: { key: 'attachement2.pdf', bucket: mockAttachmentBucket },
                    filename: 'attachment2.pdf'
                }
            ]
        };

        const resultOfEmail = await handler.sendEmails(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'SUCCESS', failedAddresses: [] });

        expect(getObjectStub).to.have.been.calledTwice;
        expect(getObjectStub).to.have.been.calledWith({ Bucket: mockAttachmentBucket, Key: 'attachement.pdf' });
        expect(getObjectStub).to.have.been.calledWith({ Bucket: mockAttachmentBucket, Key: 'attachement2.pdf' });
        expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedAssembledEmail);
    });

    it('Fails on unsupported or invalid attachment', async () => {
        const mockAttachmentBucket = 'attachments';
    
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templates: {
                htmlTemplate: validHtmlTemplate,
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray,
            attachments: [
                {
                    source: { key: 'attachement.js', bucket: mockAttachmentBucket },
                    filename: 'attachment.js'
                }
            ]
        };

        const resultOfEmail = await handler.sendEmails(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'ERR', message: 'Unsupported attachment type: attachment.js' });

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

    it('Fails on missing attachment file name', async () => {
        const mockAttachmentBucket = 'attachments';
    
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templates: {
                htmlTemplate: validHtmlTemplate,
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray,
            attachments: [
                {
                    source: { key: 'attachement.png', bucket: mockAttachmentBucket }
                }
            ]
        };

        const resultOfEmail = await handler.sendEmails(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'ERR', message: 'Invalid attachment. Missing attachment filename' });

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

    it('Fails on invalid attachment key-bucket pair', async () => {
        const mockAttachmentBucket = 'attachments';
    
        const testDestinationArray = [testDestinationDetails, testDestinationDetails, testDestinationDetails];

        const testEvent = {
            templates: {
                htmlTemplate: validHtmlTemplate,
                textTemplate: validTextTemplate
            },
            subject: validSubject,
            destinationArray: testDestinationArray,
            attachments: [
                {
                    source: { bucket: mockAttachmentBucket },
                    filename: 'attachment.doc'
                }
            ]
        };

        const resultOfEmail = await handler.sendEmails(testEvent);

        expect(resultOfEmail).to.exist;
        expect(resultOfEmail).to.deep.equal({ result: 'ERR', message: 'Invalid attachment source' });

        expect(getObjectStub).to.have.not.been.called;
        expect(sendGridStub).to.have.not.been.called;
    });

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

describe('*** UNIT TEST EMAIL MESSSAGE DISPATCH ***', async () => {
    const testMessageId = uuid();

    const chunkSize = config.get('sendgrid.chunkSize');
    const sendgridOkayResponse = [{ toJSON: () => ({ statusCode: 200 })}];
    const sendgridOkayChunk = (numberMsgs = chunkSize) => Array(numberMsgs).fill(sendgridOkayResponse);

    const validEmailEvent = (messageId = uuid()) => ({
        messageId,
        to: 'user@email.org',
        from: config.get('sendgrid.fromAddress'),
        subject: 'Welcome to Jupiter',
        text: 'Greetings. Welcome to jupiter',
        html: '<p>Greetings. Welcome to jupiter</p>'
    });

    const validEmailMessage = {
        'to': 'user@email.org',
        'from': config.get('sendgrid.fromAddress'),
        'subject': 'Welcome to Jupiter',
        'text': 'Greetings. Welcome to jupiter',
        'html': '<p>Greetings. Welcome to jupiter</p>',
        'mail_settings': { 'sandbox_mode': { 'enable': true }}
    };

    beforeEach(() => {
        resetStubs(sendGridStub);
    });

    it('Handled warm up event', async () => {
        const result = await handler.sendEmailMessages({ });

        expect(result).to.exist;
        expect(result).to.deep.equal({ result: 'Empty invocation' });

        expect(sendGridStub).to.have.not.been.called;        
    });

    it('Sends out emails', async () => {
        sendGridStub.resolves(sendgridOkayChunk(3));

        const expectedResult = { result: 'SUCCESS', failedMessageIds: [] };

        const testEvent = {
            emailMessages: [validEmailEvent(testMessageId), validEmailEvent(testMessageId), validEmailEvent(testMessageId)]
        };

        const result = await handler.sendEmailMessages(testEvent);
        expect(result).to.deep.equal(expectedResult);

        expect(sendGridStub).to.have.been.calledOnceWithExactly([validEmailMessage, validEmailMessage, validEmailMessage]);
    });

    it('Sends out emails with template wrapper', async () => {
        const numberMessages = 4;

        const mockWrapper = '<html><title></title><body>{htmlBody}</body></html>';

        getObjectStub.returns({ promise: () => ({ Body: { toString: () => mockWrapper }})});
        sendGridStub.resolves(sendgridOkayChunk(numberMessages));

        const testMessages = Array(numberMessages).fill(validEmailEvent(testMessageId));
        const testWrapper = { s3bucket: 'email.templates', s3key: 'wrapper.html' };

        const testEvent = {
            emailMessages: testMessages,
            emailWrapper: testWrapper
        };

        const result = await handler.sendEmailMessages(testEvent);
        expect(result).to.deep.equal({ result: 'SUCCESS', failedMessageIds: [] });

        const expectedWrappedMessage = '<html><title></title><body><p>Greetings. Welcome to jupiter</p></body></html>';
        const expectedMessages = Array(numberMessages).fill(validEmailMessage).map((msg) => ({ ...msg, 'html': expectedWrappedMessage }));
        
        expect(getObjectStub).to.have.been.calledOnceWithExactly({ Bucket: 'email.templates', Key: 'wrapper.html' });
        expect(sendGridStub).to.have.been.calledOnceWithExactly(expectedMessages);
    });

    it('Handles payload chunking where third party rate limit is exceeded', async () => {
        const emailMessages = [];
        
        const baseChunks = 2;
        const trailingChunkSize = 652;
        const numberMessages = baseChunks * chunkSize + trailingChunkSize;

        while (emailMessages.length < numberMessages) {
            emailMessages.push(validEmailEvent(testMessageId));
        }

        sendGridStub.resolves(sendgridOkayChunk());
        // sendGridStub.onCall(3).resolves(sendgridOkayChunk(trailingChunkSize));

        const expectedResult = { result: 'SUCCESS', failedMessageIds: [] };

        const result = await handler.sendEmailMessages({ emailMessages });

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(sendGridStub).to.have.been.calledThrice;

        const firstCall = sendGridStub.getCall(0).args[0];
        expect(firstCall.length).to.equal(1000);

        const secondCall = sendGridStub.getCall(1).args[0];
        expect(secondCall.length).to.equal(1000);

        const thirdCall = sendGridStub.getCall(2).args[0];
        expect(thirdCall.length).to.equal(652);
    });

    it('Isolated failures and returns failed message ids to caller', async () => {
        const emailMessages = [];

        const numberChunks = 3;
        const numberMessages = numberChunks * chunkSize;

        while (emailMessages.length < numberMessages) {
            emailMessages.push(validEmailEvent());
        }

        sendGridStub.onFirstCall().resolves([{ error: 'Internal error' }]);
        sendGridStub.resolves(sendgridOkayChunk());

        const result = await handler.sendEmailMessages({ emailMessages });

        expect(result).to.exist;

        expect(result).to.have.property('result', 'PARTIAL');
        expect(result).to.have.property('failedMessageIds');

        expect(result.failedMessageIds.length).to.deep.equal(1000);

        expect(sendGridStub).to.have.been.calledThrice;

        const firstCall = sendGridStub.getCall(0).args[0];
        expect(firstCall.length).to.equal(1000);

        const secondCall = sendGridStub.getCall(1).args[0];
        expect(secondCall.length).to.equal(1000);

        const thirdCall = sendGridStub.getCall(2).args[0];
        expect(thirdCall.length).to.equal(1000);
    });

    it('Fails where no valid emails are found', async () => {
        sendGridStub.resolves([{ statusCode: 200, statusMessage: 'OK' }]);

        const expectedResult = { result: 'ERR', message: 'No valid emails found' };

        const invalidEmailEvent = { ...validEmailEvent(testMessageId) };
        Reflect.deleteProperty(invalidEmailEvent, 'from');

        const testEvent = {
            emailMessages: [invalidEmailEvent, invalidEmailEvent, invalidEmailEvent]
        };

        const result = await handler.sendEmailMessages(testEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(sendGridStub).to.have.not.been.called;
    });

    it('Catches thrown errors', async () => {
        sendGridStub.throws(new Error('Dispatch error'));

        const expectedResult = { result: 'ERR', message: 'Dispatch error' };

        const testEvent = {
            emailMessages: [validEmailEvent(testMessageId), validEmailEvent(testMessageId), validEmailEvent(testMessageId)]
        };

        const result = await handler.sendEmailMessages(testEvent);

        expect(result).to.exist;
        expect(result).to.deep.equal(expectedResult);

        expect(sendGridStub).to.have.been.calledOnceWithExactly([validEmailMessage, validEmailMessage, validEmailMessage]);
    });

});
