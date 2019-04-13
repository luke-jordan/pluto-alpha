process.env.NODE_ENV = 'test';

const logger = require('debug')('pluto:float:test');

const chai = require('chai');
const expect = chai.expect;

const handler = require('../handler');

describe('moneyMktFloatAccrual', () => {

    it('Happy path', async () => {
        const amountAccrued = 737215;
        const accrualRequest = {
            FloatId: 'primary-cash-float',
            AmountAccrued: amountAccrued,
            Currency: 'ZAR',
            Unit: 'HUNDREDTH-CENT'
        };

        const response = await handler.accrue(accrualRequest);
        expect(response.statusCode).to.equal(200);
        expect(response.entity).to.exist;

        expect(response.companyShare).to.exist;
        const companyShare = response.entity.company_share;
        expect(companyShare).to.be.lessThan(amountAccrued);

        expect(response.entity.float_total).to.be.greaterThan(amountAccrued - companyShare);
        expect(response.entity.bonus_pool).to.be.lessThan(amountAccrued - companyShare);

        expect(response.entity.recon_job_id).to.exist;
    });

});