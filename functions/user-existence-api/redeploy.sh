#! /bin/bash

echo "Zipping up the code"
sls package --stage local

echo "Redeploying account create"
awslocal lambda update-function-code --function-name 'account_create' --zip-file fileb://.serverless/user-existence-api.zip

echo "Redeploying account profile"
awslocal lambda update-function-code --function-name 'profile_create' --zip-file fileb://.serverless/user-existence-api.zip

echo "Redeploying fetch account"
awslocal lambda update-function-code --function-name 'profile_find_by_details' --zip-file fileb://.serverless/user-existence-api.zip

echo "Redeploying fetch profile"
awslocal lambda update-function-code --function-name 'profile_fetch' --zip-file fileb://.serverless/user-existence-api.zip
