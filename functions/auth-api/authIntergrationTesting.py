import os
import time
import json
import boto3
import string
import secrets
from uuid import uuid4
from colorama import Fore

user_pool = []
updated_user_pool = []
pending_update_user_pool = []
successful_logins = 0
alphabet = string.ascii_letters + string.digits
user_quota = 1 # the number of users to generate

dynamodb = boto3.client('dynamodb', endpoint_url = 'http://localhost:4569')
local_lambda = boto3.client('lambda', endpoint_url = 'http://localhost:4574')

def print_deployed_functions():
    function_list = local_lambda.list_functions()
    # print(function_list)
    print('Function list: ', [function['FunctionName'] for function in function_list['Functions']])


# setup db
# deploy lambdas

def sign_in_user(user_object, pool=user_pool, hack=False):
    if hack:
        invocation_command = 'sls invoke local -f insertUserCredentials -d ' + json.dumps(json.dumps({
            'systemWideUserId': user_object['systemWideUserId'],
            'password': user_object['password']
        }))
        print('about to invoke sign in lambda with command: %s' % invocation_command)
        os.system(invocation_command)
        user_pool.append(user_object)
        print('contents of user_pool: %s' % str(user_pool))
    else:
        print('user sign in function recieved: %s' % str(user_object))
        lambda_response = local_lambda.invoke(FunctionName='auth-api-local-insertUserCredentials', InvocationType='RequestResponse', Payload=json.dumps({
            'systemWideUserId': user_object['systemWideUserId'],
            'password': user_object['password']
        }))
        print('sign-in request to lambda with user %s returned: %s' % (str(user_object), str(lambda_response)))
        if lambda_response['statusCode'] == 200:
            user_pool.append(user_object)
        return lambda_response


def login_user(user_object, hack=False):
    if hack:
        invocation_command = 'sls invoke local -f verifyUserCredentials -d ' + json.dumps(json.dumps({
            'systemWideUserId': user_object['systemWideUserId'],
            'password': user_object['password']
        }))
        print('about to invoke login lambda with command: %s' % invocation_command)
        os.system(invocation_command)
    else:
        global successful_logins
        print('user login function recieved args: %s' % str(user_object))
        lambda_response = local_lambda.invoke(FunctionName='auth-api-local-verifyUserCredentials', InvocationType='RequestResponse', Payload=json.dumps({
            'systemWideUserId': user_object.systemWideUserId,
            'password': user_object.password
        }))
        print('login request to lambda with user %s returned: %s' % (str(user_object), str(lambda_response)))
        if lambda_response['statusCode'] ==  200:
            successful_logins += 1
        return lambda_response


def update_user_password(user_update_object, hack=False):
    if hack:
        invocation_command = 'sls invoke local -f updatePassword -d ' + json.dumps(json.dumps(user_update_object))
        print('about to invoke login lambda with command: %s' % invocation_command)
        os.system(invocation_command)
        updated_user_pool.append({
            'systemWideUserId': user_update_object['systemWideUserId'],
            'password': user_update_object['newPassword']
        })
        print('updated user pool now looks like: %s' % str(updated_user_pool))
    else:
        print('Attemting to change user %s password from %s to %s' % (
            user_update_object['systemWideUserId'],
            user_update_object['oldPassword'],
            user_update_object['newPassword']
        ))

        lambda_response = local_lambda.invoke(FunctionName='create-account', InvocationType='RequestResponse', Payload=json.dumps({
            'systemWideUserId': user_update_object['systemWideUserId'],
            'oldPassword': user_update_object['oldPassword'],
            'newPassword': user_update_object['newPassword']
        }))

        if lambda_response['satusCode'] == 200:
            updated_user_pool.append({
                'systemWideUserId': user_update_object['systemWideUserId'],
                'password': user_update_object['new_password']
            })
        print('password update request to lambda with user object %s returned: %s' % (str(user_update_object), str(lambda_response)))
        return lambda_response


def change_user_passwords():
    for user in user_pool:
        user_update_object = {
            'systemWideUserId': user['systemWideUserId'],
            'oldPassword': user['password'],
            'newPassword': generate_password()          
        }
        pending_update_user_pool.append(user_update_object)
    print('completed password update pool. resulted in %s update objects' % len(pending_update_user_pool)) 


def generate_password():
    return ''.join(secrets.choice(alphabet) for i in range(20))


def generate_new_user():
    return {
        'systemWideUserId': str(uuid4()),
        'password': generate_password()
    }


def run(user_quota=user_quota):
    ## create new users
    for i in range(user_quota):
        print(separator)
        print(Fore.GREEN + 'Now signing in user %s of %s\n' % (i + 1, user_quota) + Fore.WHITE)
        time.sleep(2)
        user = generate_new_user()
        print('attempting to register user: %s' % str(user))
        insertion_response = sign_in_user(user)
        print('credentials insertion request resulted in %s' % str(insertion_response))
        time.sleep(5)
    # print(Fore.GREEN + '\nnow attemting to login' + Fore.WHITE)
    ## login users created above
    print(separator)
    print(Fore.GREEN + 'user insertion process complete. %s/%s users made it through' % (len(user_pool), user_quota) + Fore.WHITE)
    for i in range(len(user_pool)):
        print(separator)
        print(Fore.GREEN + 'Now logging in user %s of %s\n' % (i+1, len(user_pool)) + Fore.WHITE)
        time.sleep(2)
        login_response = login_user(user_pool[i])
        print('login request resulted in %s' % str(login_response))
        time.sleep(5)
    ## login non existent users TODO: simply omit sign in step in this sequence
    ## login in valid users with bad passwords TODO: intentionally corrupt passwords and see what happens
    ## update user passwords
    print(separator)
    print(Fore.GREEN + 'user login batch process complete. %s/%s made it through.' % (successful_logins, user_quota) + Fore.WHITE)
    change_user_passwords()
    for i in range(len(pending_update_user_pool)):
        print(separator)
        print(Fore.GREEN + 'about to update user password for user %s of %s' % (i + 1, len(pending_update_user_pool)) + Fore.WHITE)
        time.sleep(2)
        update_response = update_user_password(pending_update_user_pool[i], hack=True)
        time.sleep(5)
    print(separator)
    print(Fore.GREEN + 'password update on %s users complete. Ready to login in with new credentials' % len(pending_update_user_pool) + Fore.WHITE)
    ## login with new credentials
    for i in range(len(updated_user_pool)):
        print(separator)
        print(Fore.GREEN + 'Now logging in user %s of %s\n' % (i + 1, len(updated_user_pool)) + Fore.WHITE)
        time.sleep(2)
        login_response = login_user(updated_user_pool[i], hack=True)
        print('login request resulted in %s' % str(login_response))
        time.sleep(5)
    print('user login batch process complete. %s/%s made it through.' % (successful_logins, user_quota))
    print('I hope you\'re pleased.')


separator = '_______________________________________________________________________\n'

if __name__ == "__main__":
    run() # override user_quota within as arg to this function