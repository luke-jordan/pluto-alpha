resource "aws_iam_policy" "dynamo_table_client_float_table_access" {
  name        = "ClientFloatTable_access_${terraform.workspace}"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AccessClientFloatTable",
            "Effect": "Allow",
            "Action": [
                "dynamodb:GetItem",
                "dynamodb:Query"
            ],
            "Resource": "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:${var.aws_account}:table/ClientFloatTable"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "migration_script_s3_access" {
  name        = "migration_script_s3_access_${terraform.workspace}"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "MigrationScriptAccess",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject"
            ],
            "Resource": "arn:aws:s3:::jupiter.db.migration.scripts/${terraform.workspace}/*"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_invoke_warmup_access" {
    name = "warmup_lambda_invoke_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "WarmupLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "arn:aws:lambda:${var.aws_default_region["${terraform.workspace}"]}:${var.aws_account}:function:balance_fetch",
                "arn:aws:lambda:${var.aws_default_region["${terraform.workspace}"]}:${var.aws_account}:function:balance_fetch_wrapper",
                "arn:aws:lambda:${var.aws_default_region["${terraform.workspace}"]}:${var.aws_account}:function:save_initiate",
                "arn:aws:lambda:${var.aws_default_region["${terraform.workspace}"]}:${var.aws_account}:function:save_payment_check"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "ops_sns_user_event_publish" {
  name    = "OpsSNSUserLogEvent_access_${terraform.workspace}"
  path    = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "SNSAccess",
            "Effect": "Allow",
            "Action": [
                "SNS:Publish*"
            ],
            "Resource": "${var.user_event_topic_arn[terraform.workspace]}"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_invoke_float_transfer_access" {
    name = "lambda_float_transfer_invoke_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "WarmupLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.float_transfer.arn}"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_invoke_message_create_access" {
    name = "lambda_message_user_create_invoke_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "WarmupLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.message_user_create.arn}"
            ]
        }
    ]
}
EOF
}