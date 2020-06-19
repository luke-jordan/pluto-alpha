'use strict';

const chai = require('chai');
chai.use(require('sinon-chai'));
const expect = chai.expect;

module.exports.wrapAuthorizedRequest = (body, systemWideUserId) => ({
    httpMethod: 'POST',
    pathParameters: { proxy: 'create' },
    requestContext: { authorizer: { systemWideUserId, role: 'SYSTEM_ADMIN' } },
    body: JSON.stringify(body)
});

module.exports.standardOkayChecks = (wrappedResult, expectedBody) => {
    expect(wrappedResult).to.have.property('statusCode', 200);
    expect(wrappedResult).to.have.property('headers');
    expect(wrappedResult).to.have.property('body');

    const unWrappedResult = JSON.parse(wrappedResult.body);
    expect(unWrappedResult).to.deep.equal(expectedBody);
};

module.exports.itemizedSelectionCheck = (executeConditionsStub, expectedPersistenceParams, expectedSelection, callNumber = 0) => {
    const executedArgs = executeConditionsStub.getCall(callNumber).args;
    expect(executedArgs[0]).to.deep.equal(expectedSelection);
    expect(executedArgs[1]).to.be.true;
    expect(executedArgs[2]).to.deep.equal(expectedPersistenceParams);
};
