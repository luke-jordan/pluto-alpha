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
                "dynamodb:*"
            ],
            "Resource": "arn:aws:dynamodb:${var.aws_default_region["${terraform.workspace}"]}:*:table/ClientFloatTable"
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
                "s3:*"
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
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "arn:aws:lambda:${var.aws_default_region["${terraform.workspace}"]}:${var.aws_account}:function:balance_fetch",
                "arn:aws:lambda:${var.aws_default_region["${terraform.workspace}"]}:${var.aws_account}:function:balance_fetch_wrapper",
                "arn:aws:lambda:${var.aws_default_region["${terraform.workspace}"]}:${var.aws_account}:function:saving_record"
            ]
        }
    ]
}
EOF
}
