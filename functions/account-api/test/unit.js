process.env.NODE_ENV = 'test';

const logger = require('debug')('u:account:test')
const config = require('config');

const chai = require('chai');
const expect = chai.expect;

chai.use(require('chai-uuid'));

const handler = require('../handler');

const testAccountOpeningRequest = {
    UserId: 'whole-of-system-unique-user-id',
    UserPersonalName: 'Luke Jordan',    
}

describe('transformEvent', () => {
    
});

describe('openAccount', () => {
    it('Same owner and user', async () => {
        logger('Up and running');
        
        const response = await handler.createAccount();
        expect(response.statusCode).to.equal(200);
        expect(response.entity).to.exist;
        expect(response.entity.account_id).to.be.a.uuid('v4');
        expect(response.entity.tags).to.be.empty;
        expect(response.entity.flags).to.be.empty;
    });
});

