
from locust import HttpLocust, TaskSet, TaskSequence, task, seq_task
import random
import uuid
import json

test_email = 'kangxi@qing.com'
test_phone = '27825621117'
test_token = '' # Registration token

def generate_uuid():
    return str(uuid.uuid4())

def otp_gen(min_val=1000, max_val=9999):
    return random.randint(min_val, max_val)

def password_gen():
    return 'fleeting_FOXES_200'

class TestAuthEndpoints(TaskSequence):
    
    def on_start(self):
        self.base_url = 'https://staging-auth.jupiterapp.net'
        self.login()

    def login(self):
        data = {
            "phoneOrEmail": "busani@jupitersave.com",
            "password": f"{password_gen()}",
            "otp":"1111"
        }
        response = self.client.post(
            url=f"{self.base_url}/login",
            data=json.dumps(data),
            headers={"authorization": "Bearer " + test_token}
        )
        print("Response status code (/login):", response.status_code)
        print("Response content (/login):", response.text)
        parsed_result = json.loads(response.text)
        self.token = parsed_result['token']
        self.user_id = parsed_result['systemWideUserId']
    
    @task
    def generate_otp(self):
        data = { "phoneOrEmail": f"{test_email}", "type": "REGISTER" }
        response = self.client.post(
            url=f"{self.base_url}/otp/generate",
            data=json.dumps(data),
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/otp/generate):", response.status_code)
        print("Response content (/otp/generate):", response.text)

    @task
    def verify_otp(self):
        data = {
            "systemWideUserId": f"{self.user_id}",
            "otp": f"{1111}"
        }
        response = self.client.post(
            url=f"{self.base_url}//otp/verify",
            data=json.dumps(data),
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/otp/verify):", response.status_code)
        print("Response content (/otp/verify):", response.text)

    @task    
    def verify_referral(self):
        data = { "referralCode": "LETMEIN" }
        response = self.client.post(
            url=f"{self.base_url}/referral/verify",
            data=json.dumps(data),
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/referral/verify):", response.status_code)
        print("Response content (/referral/verify):", response.text)

    @task    
    def register_list(self):
        data = {
            "phoneOrEmail": f"{test_email}",
            "countryCode3Letter": "ZAF",
            "source": "ANDROID"
        }
        response = self.client.post(
            url=f"{self.base_url}/register/list",
            data=json.dumps(data),
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/register/list): %s" % response.status_code)
        print("Response content (/register/list): %s" % response.text)

    # @seq_task(1)
    @task
    def register_profile(self):
        data = {
            "countryCode3Letter": 'ZAF',
            "nationalId": f"940325{random.randint(100000000, 999999999)}",
            "phoneOrEmail": f"{test_email}",
            "personalName": "Kangxi",
            "familyName": "Qing",
            "referralCode": "LETMEIN"
        }
        response = self.client.post(
            url=f"{self.base_url}/register/profile",
            data=json.dumps(data),
        )
        print("Response status code (/register/profile): %s" % response.status_code)
        print("Response content (/register/profile): %s" % response.text)
        parsed_result = json.loads(response.text);
        print('Got: %s' %parsed_result['systemWideUserId'])
        self.user_id = parsed_result['systemWideUserId']
        self.client_id = parsed_result['clientId']
        self.float_id = parsed_result['defaultFloatId']
        self.currency = parsed_result['defaultCurrency']
        self.phone_or_email = data['phoneOrEmail'] 

    # @seq_task(2)
    @task
    def register_password(self):
        print('Woriking with: %s' % self.user_id)
        print('Woriking with: %s' % self.client_id)
        print('Woriking with: %s' % self.float_id)
        print('Woriking with: %s' % self.currency)
        print('Woriking with: %s' % self.phone_or_email)

        data = {
            "systemWideUserId": f"{self.user_id}",
            "password": f"{password_gen()}",
            "clientId": f"{self.client_id}",
            "floatId": f"{self.float_id}",
            "currency": f"{self.currency}"
        }
        response = self.client.post(
            url=f"{self.base_url}/register/password",
            data=json.dumps(data)
        )
        print("Response status code (/register/password): %s" % response.status_code)
        print("Response content (/register/passowrd): %s" % response.text)
        parsed_result = json.loads(response.text)
        print('Got token: %s:' % parsed_result['token'])
        self.token = parsed_result['token']

    @task
    def generate_password(self):
        response = self.client.get(
            url=f"{self.base_url}/password/generate",
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/password/generate):", response.status_code)
        print("Response content (/password/generate):", response.text)

    @task
    def obtain_security_questions(self):
        response = self.client.get(
            url=ff"{self.base_url}/password/reset/obtainqs?systemWideUserId=\"{self.user_id}\"",
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/password/reset/obtainqs):", response.status_code)
        print("Response content (/password/reset/obtainqs):", response.text)

    @task
    def submit_security_answers(self):
        data = {
            "dryRunFakeSuccess": True,
            # "MONTH_OPEN": "2019-11-08T10:00:00.000Z",
            # "CURRENT_BALANCE": 0,
            # "MONTHLY_SAVING_EVENTS": 0
        }
        response = self.client.post(
            url=f"{self.base_url}/password/reset/answerqs",
            data=json.dumps(data),
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/password/reset/answerqs):", response.status_code)
        print("Response content (/password/reset/answerqs):", response.text)

    @task
    def complete_password_reset(self):
        data = {
            "newPassword": f"{password_gen()}",
            "systemWideUserId": f"{self.user_id}",
            "oldPassword": f"{password_gen()}" # optional
        }
        response = self.client.post(
            url=f"{self.base_url}/password/reset/complete",
            data=json.dumps(data),
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/password/reset/complete):", response.status_code)
        print("Response content (/password/reset/complete):", response.text)

    @task
    def fetch_user_profile(self):
        response = self.client.get(
            url=f"{self.base_url}/profile/fetch",
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/profile/fetch):", response.status_code)
        print("Response content (/profile/fetch):", response.text)

    @task
    def support(self):
        data = {
            "contactDetail": f"{test_email}",
            "messageDetails": "Greetings. I need help. Thank you."
        }
        response = self.client.post(
            url=f"{self.base_url}/ineedhelp",
            data=json.dumps(data),
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/indeedhelp):", response.status_code)
        print("Response content (/ineedhelp):", response.text)


class TestOpsEndpoints(TaskSet):
    def on_start(self):
        self.base_url = 'https://staging.jupiterapp.net'
        self.login()

    def login(self):
        data = {
            "phoneOrEmail": "busani@jupitersave.com",
            "password": f"{password_gen()}",
            "otp":"1111"
        }
        response = self.client.post(
            url="https://staging-auth.jupiterapp.net/login",
            data=json.dumps(data),
            headers={"authorization": "Bearer " + test_token}
        )
        print("Response status code (/login):", response.status_code)
        print("Response content (/login):", response.text)
        parsed_result = json.loads(response.text)
        self.token = parsed_result['token']
        self.user_id = parsed_result['systemWideUserId']
        self.account_id = parsed_result['accountId']
    
    @task
    def fetch_user_balance(self):
       response = self.client.get(
            url=f"{self.base_url}/balance",
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/balance):", response.status_code)
        print("Response content (/balance):", response.text)
   
    @task
    def add_cash_initiate(self):
        test_amount = '10'
        data = {
            'accountId': f'{self.account_id}',
            'savedAmount': f'{test_amount}',
            'savedCurrency': 'ZAR',
            'savedUnit': 'HUNDREDTH_CENT',
        }
        response = self.client.post(
            url=f'{self.base_url}/addcash/initiate',
            data=json.dumps(data),
            headers={"authorization": "Bearer " + self.token}
        )
        print("Response status code (/addcash/initiate):", response.status_code)
        print("Response content (/addcash/initiate):", response.text)
        parsed_result = json.loads(response.text)
        self.tx_id = parsed_result['transactionDetails'][0]['accountTransactionId']
        print('Got transaction id:', self.tx_id)

    @task    
    def add_cash_check(self):
        response = self.client.get(url=f"{self.base_url}/addcash/check?transactionId='{self.tx_id}'&&failureType='PENDING'", headers={"authorization": "Bearer " + self.token})
        print("Response status code (/addcash/check):", response.status_code)
        print("Response content (/addcash/check):", response.text)
        

    @task    
    def add_cash_settle(self):
        data = {
            'transactionId': self.tx_id
            'paymentRef': ''
            'settledTimeMillis': ''
        }
        response = self.client.post(url=f'{self.base_url}/addcash/settle', data=json.dumps(data), headers={"authorization": "Bearer " + self.token})
        print("Response status code (/addcash/settle):", response.status_code)
        print("Response content (/addcash/settle):", response.text)

    @task    
    def add_cash_cancel(self):
        data = {
            'transactionId': self.tx_id
            'reasonToLog': ''
        }
        response = self.client.post( url=f'{self.base_url}/addcash/cancel', data=json.dumps(data), headers={"authorization": "Bearer " + self.token})
        print("Response status code (/addcash/cancel):", response.status_code)
        print("Response content (/addcash/cancel):", response.text)

    @task
    def fetch_message(self):
        response = self.client.get(url=f"{self.base_url}/message/fetch",headers={"authorization": "Bearer " + self.token})
        print("Response status code (/message/fetch):", response.status_code)
        print("Response content (/message/fetch):", response.text)

    @task
    def process_message(self):
        data = {
            'messageId': ''
            'userAction': 'DISMISSED'
        }
        response = self.client.post(url=f'{self.base_url}/message/process', data=json.dumps(data), headers={"authorization": "Bearer " + self.token})
        print("Response status code (/message/process):", response.status_code)
        print("Response content (/message/process):", response.text)

    @task
    def message_token(self):
        data = {
            'proviser': 'EXPO'
            'token': ''
        }
        response = self.client.post(url=f'{self.base_url}/message/token', data=json.dumps(data), headers={"authorization": "Bearer " + self.token})
        print("Response status code (/message/token):", response.status_code)
        print("Response content (/message/token):", response.text)

    @task
    def initiate_withdrawal(self):
        data = {
            'accountId': self.account_id,
            'bankDetails': {
                'accountHolder': self.user_id
                'bankName': 'FNB'
                'accountNumber': ''
            }
        }
        response = self.client.post(url=f'{self.base_url}/withdrawal/initiate', data=json.dumps(data), headers={"authorization": "Bearer " + self.token})
        print("Response status code (//withdrawal/initiate):", response.status_code)
        print("Response content (/withdrawal/initiate):", response.text)

    @task
    def withdrawal_amount(self):
        test_amount = '10'
        data = {
            'accountId': self.account_id
            'amount': test_amount,
            'unit': 'HUNDREDTH_CENT',
            'currency': 'ZAR'
        }
        response = self.client.post(url=f'{self.base_url}/withdrawal/amount', data=json.dumps(data), headers={"authorization": "Bearer " + self.token})
        print("Response status code (//withdrawal/amount):", response.status_code)
        print("Response content (/withdrawal/amount):", response.text)
        self.transaction_id = parsed_result['transactionId']

    @task
    def withdrawal_decision(self):
        test_amount = '10'
        data = {
            'transactionId': self.transaction_id
            'userDecision': 'CANCEL'
        }
        response = self.client.post(url=f'{self.base_url}/withdrawal/decisoon', data=json.dumps(data), headers={"authorization": "Bearer " + self.token})
        print("Response status code (//withdrawal/decision):", response.status_code)
        print("Response content (/withdrawal/decision):", response.text)


class AuthUser(HttpLocust):
    task_set = TestAuthEndpoints
    min_wait = 5000
    max_wait = 9000

class OpsUser(HttpLocust):
    task_set = TestOpsEndpoints
    min_wait = 5000
    max_wait = 9000

