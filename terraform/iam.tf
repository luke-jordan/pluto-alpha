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

resource "aws_iam_policy" "admin_client_float_access" {
  name = "lambda_admin_client_float_list_${terraform.workspace}"
  path = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Sid": "ClientFloatAdminAccess",
        "Effect": "Allow",
        "Action": [
          "dynamodb:Scan",
          "dynamodb:Query",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem"
        ],
        "Resource": [
          "${aws_dynamodb_table.client-float-table.arn}",
          "${var.country_client_table_arn[terraform.workspace]}"
        ]
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
            "Resource": "arn:aws:s3:::jupiter.db.migration.scripts/${terraform.workspace}/ops/*"
        },
        {
            "Sid": "ListBucketAccess",
            "Effect": "Allow",
            "Action": [
                "s3:ListBucket"
            ],
            "Resource": "arn:aws:s3:::jupiter.db.migration.scripts"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "templates_s3_access" {
    name      = "${terraform.workspace}_templates_s3_access"
    path      = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "GenericTemplateAccess",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject"
            ],
            "Resource": "arn:aws:s3:::${terraform.workspace}.jupiter.templates/*"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_invoke_ops_warmup_access" {
    name = "warmup_ops_lambda_invoke_access_${terraform.workspace}"
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
                "${aws_lambda_function.balance_fetch.arn}",
                "${aws_lambda_function.balance_fetch_wrapper.arn}",
                "${aws_lambda_function.save_initiate.arn}",
                "${aws_lambda_function.save_payment_check.arn}",
                "${aws_lambda_function.message_user_fetch.arn}",
                "${aws_lambda_function.user_history_list.arn}",
                "${aws_lambda_function.referral_verify.arn}"
            ],
            "Condition": {
                "StringEquals": {
                    "aws:PrincipalArn": "${aws_iam_role.ops_warmup_role.arn}"
                }
            }
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
                "${aws_lambda_function.message_user_create_once.arn}"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_invoke_message_process_access" {
    name = "lambda_message_user_process_invoke_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "MessageProcessInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.message_user_process.arn}"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_invoke_boost_create_access" {
    name = "lambda_boost_create_invoke_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "BoostLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.boost_create.arn}"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_invoke_msg_instruct_access" {
    name = "lambda_invoke_msg_instruct_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "MsgInstructLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.message_instruct_create.arn}"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_invoke_payment_access" {
    name = "lambda_invoke_payment_urls_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "PaymentUrlLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.payment_url_request.arn}",
                "${aws_lambda_function.payment_status_check.arn}"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "save_check_invoke_access" {
    name    = "${terraform.workspace}_save_check_lambda_access"
    path    = "/"
    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "SaveCheckLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.save_payment_check.arn}"
            ]
        }
    ]
}
EOF
}

/////////////// COMPOSITE POLICIES FOR PROCESSING/ADMIN LAMBDAS THAT DO A LOT ///////////////////

resource "aws_iam_policy" "lambda_invoke_user_event_processing" {
    name = "lambda_user_event_process_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AllowInvokeBoostProcess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.boost_event_process.arn}"
            ]
        },
        {
            "Sid": "AllowInvokeStatusUpdate",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${var.user_status_lambda_arn[terraform.workspace]}"
            ]
        },
        {
            "Sid": "AllowPublishDLQ",
            "Effect": "Allow",
            "Action": [
                "sqs:GetQueueUrl",
                "sqs:SendMessage"
            ],
            "Resource": [
                "${aws_sqs_queue.user_event_dlq.arn}"
            ]
        },
        {
            "Sid": "EmailSend",
            "Effect": "Allow",
            "Action": [
                "ses:SendEmail"
            ],
            "Resource": [
                "arn:aws:ses:${var.aws_default_region[terraform.workspace]}:455943420663:identity/jupitersave.com",
                "arn:aws:ses:${var.aws_default_region[terraform.workspace]}:455943420663:identity/${var.events_source_email_address[terraform.workspace]}"
            ],
            "Condition": {
                "StringLike": {
                    "ses:FromAddress": "${var.events_source_email_address[terraform.workspace]}"
                }
            }
        },
        {
            "Sid": "EmailTemplateAccess",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject"
            ],
            "Resource": "arn:aws:s3:::${terraform.workspace}.jupiter.templates/*"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "daily_job_lambda_policy" {
    name = "lambda_scheduled_system_job_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "FloatAccrualLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.float_accrue.arn}"
            ]
        },
        {
            "Sid": "EmailSend",
            "Effect": "Allow",
            "Action": [
                "ses:SendEmail"
            ],
            "Resource": [
                "arn:aws:ses:${var.aws_default_region[terraform.workspace]}:455943420663:identity/jupitersave.com",
                "arn:aws:ses:${var.aws_default_region[terraform.workspace]}:455943420663:identity/${var.events_source_email_address[terraform.workspace]}"
            ],
            "Condition": {
                "StringLike": {
                    "ses:FromAddress": "${var.events_source_email_address[terraform.workspace]}"
                }
            }
        },
        {
            "Sid": "EmailTemplateAccess",
            "Effect": "Allow",
            "Action": [
                "s3:GetObject"
            ],
            "Resource": "arn:aws:s3:::${terraform.workspace}.jupiter.templates/*"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "referral_code_read_policy" {
    name = "dynamo_table_referral_read_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ReferralCodeReadAccess",
            "Effect": "Allow",
            "Action": [
                "dynamodb:Query",
                "dynamodb:GetItem"
            ],
            "Resource": [
                "${aws_dynamodb_table.active_referral_code_table.arn}",
                "${aws_dynamodb_table.active_referral_code_table.arn}/index/*"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "referral_code_write_policy" {
    name = "dynamo_table_referral_write_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ReferralCodeWriteAccess",
            "Effect": "Allow",
            "Action": [
                "dynamodb:PutItem",
                "dynamodb:UpdateItem"
            ],
            "Resource": [
                "${aws_dynamodb_table.active_referral_code_table.arn}",
                "${aws_dynamodb_table.active_referral_code_table.arn}/index/*"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "referral_code_deactivate_policy" {
    name = "dynamo_table_referral_archive_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ArchiveWriteAccess",
            "Effect": "Allow",
            "Action": [
                "dynamodb:PutItem",
                "dynamodb:UpdateItem"
            ],
            "Resource": [
                "${aws_dynamodb_table.archived_referral_code_table.arn}"
            ]
        },
        {
            "Sid": "ActiveDeleteAccess",
            "Effect": "Allow",
            "Action": [
                "dynamodb:DeleteItem"
            ],
            "Resource": [
                "${aws_dynamodb_table.active_referral_code_table.arn}",
                "${aws_dynamodb_table.active_referral_code_table.arn}/index/*"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "balance_lambda_invoke_policy" {
    name = "${terraform.workspace}_lambda_balance_fetch_invoke"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "BalanceLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.balance_fetch.arn}"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "admin_save_settle_lambda_invoke_policy" {
    name = "${terraform.workspace}_lambda_save_settle_invoke"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "SettleLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.save_admin_settle.arn}"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_referral_code_open" {
  name        = "lambda_referral_create_invoke_${terraform.workspace}"
  path        = "/"

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ReferralCodeCreateInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": "${aws_lambda_function.referral_create.arn}"
        }
    ]
}
EOF
}

resource "aws_iam_policy" "lambda_invoke_admin_referral_access" {
    name = "referral_admin_lambda_invoke_access_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "ReferralLambdaInvokeAccess",
            "Effect": "Allow",
            "Action": [
                "lambda:InvokeFunction",
                "lambda:InvokeAsync"
            ],
            "Resource": [
                "${aws_lambda_function.referral_verify.arn}",
                "${aws_lambda_function.referral_create.arn}",
                "${aws_lambda_function.referral_modify.arn}"
            ]
        }
    ]
}
EOF
}

resource "aws_iam_policy" "admin_log_write_policy" {
    name = "dynamo_table_adminlog_write_${terraform.workspace}"
    path = "/"

    policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "AdminLogPutAccess",
            "Effect": "Allow",
            "Action": [
                "dynamodb:PutItem"
            ],
            "Resource": [
                "${aws_dynamodb_table.admin_log_table.arn}"
            ]
        }
    ]
}
EOF
}
