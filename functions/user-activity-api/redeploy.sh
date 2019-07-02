#! /bin/bash

echo "Zipping up the code"
sls package --stage local

# echo "Redeploying update"
# awslocal lambda update-function-code --function-name 'activity-save' --zip-file fileb://.serverless/user-activity-api.zip

echo "Redeploying balance"
awslocal lambda update-function-code --function-name 'activity-balance' --zip-file fileb://.serverless/user-activity-api.zip
