// On each new function : add to aws_api_gateway_deployment's depends_on related component

resource "aws_api_gateway_rest_api" "api_gateway" {
  name        = "${terraform.workspace}_rest_api"
  description = "API for admin functions"
}

resource "aws_api_gateway_deployment" "api_deployment" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  stage_name  = terraform.workspace

  depends_on = [
  aws_api_gateway_integration.referral_verify,
  aws_api_gateway_integration.save_initiate,
  aws_api_gateway_integration.save_payment_check,
  aws_api_gateway_integration.balance_fetch_wrapper,
  aws_api_gateway_integration.user_history_list,
  aws_api_gateway_integration.message_fetch_wrapper,
  aws_api_gateway_integration.message_process,
  aws_api_gateway_integration.message_token_store,
  aws_api_gateway_integration.message_token_delete,
  
  aws_api_gateway_integration.boost_user_process,
  aws_api_gateway_integration.boost_user_list,
  aws_api_gateway_integration.boost_user_changed,
  aws_api_gateway_integration.boost_detail_fetch,
  
  aws_api_gateway_integration.user_friend_list,
  aws_api_gateway_integration.friend_deactivate,
  aws_api_gateway_integration.friend_request_manage,
  aws_api_gateway_integration.friend_alert_manage,
  aws_api_gateway_integration.friend_pool_read,
  aws_api_gateway_integration.friend_pool_write,

  aws_api_gateway_integration.snippet_user_fetch

  ]

  variables = {
    commit_sha1 = var.deploy_code_commit_hash
  }

  lifecycle {
    create_before_destroy = true
  }
}

/////////////////////// API GW AUTHORIZER ///////////////////////////////////////////////////////////////

resource "aws_api_gateway_authorizer" "jwt_authorizer" {
  name = "api_gateway_jwt_authorizer_${terraform.workspace}"
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  type = "TOKEN"
  authorizer_result_ttl_in_seconds = 300
  authorizer_uri = "arn:aws:apigateway:${var.aws_default_region[terraform.workspace]}:lambda:path/2015-03-31/functions/${var.jwt_authorizer_arn[terraform.workspace]}/invocations"
}

resource "aws_iam_role" "auth_invocation_role" {
  name = "${terraform.workspace}_api_gateway_auth_invocation"
  path = "/"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "sts:AssumeRole",
      "Principal": {
        "Service": "apigateway.amazonaws.com"
      },
      "Effect": "Allow",
      "Sid": ""
    }
  ]
}
EOF
}

resource "aws_iam_role_policy" "invocation_policy" {
  name = "default"
  role = aws_iam_role.auth_invocation_role.id

  policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Action": "lambda:InvokeFunction",
      "Effect": "Allow",
      "Resource": "${var.jwt_authorizer_arn[terraform.workspace]}"
    }
  ]
}
EOF
}

/////////////////////// API GW LOGGING ///////////////////////////////////////////////////////////////
resource "aws_api_gateway_account" "api_gateway" {
  cloudwatch_role_arn = aws_iam_role.api_gateway_cloudwatch.arn

  depends_on = [aws_iam_role.api_gateway_cloudwatch]
}

resource "aws_iam_role" "api_gateway_cloudwatch" {
  name = "api_gateway_ops_cloudwatch_${terraform.workspace}"

  assume_role_policy = <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "",
      "Effect": "Allow",
      "Principal": {
        "Service": "apigateway.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF
}

resource "aws_iam_role_policy" "api_gateway_cloudwatch" {
  name = "default"
  role = aws_iam_role.api_gateway_cloudwatch.id

  policy = <<EOF
{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:DescribeLogGroups",
                "logs:DescribeLogStreams",
                "logs:PutLogEvents",
                "logs:GetLogEvents",
                "logs:FilterLogEvents"
            ],
            "Resource": "*"
        }
    ]
}
EOF
}

resource "aws_api_gateway_method_settings" "general_settings" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  stage_name  = aws_api_gateway_deployment.api_deployment.stage_name
  method_path = "*/*"

  settings {
    # Enable CloudWatch logging and metrics
    metrics_enabled        = true
    data_trace_enabled     = true
    logging_level          = "INFO"

    # Limit the rate of calls to prevent abuse and unwanted charges
    throttling_rate_limit  = 100
    throttling_burst_limit = 50
  }
}

/////////////////////// API GW DOMAIN ////////////////////////////////////////////////////////////////

resource "aws_api_gateway_domain_name" "custom_doname_name" {
  certificate_arn = "arn:aws:acm:us-east-1:455943420663:certificate/6fb77289-8ee8-420a-8f5b-6d62782e091e"
  domain_name     = "${terraform.workspace}.jupiterapp.net"
}

resource "aws_route53_record" "route" {
  name    = aws_api_gateway_domain_name.custom_doname_name.domain_name
  type    = "A"
  zone_id = "Z32F5PRK3A4ONK"

  alias {
    evaluate_target_health = true
    name                   = "${aws_api_gateway_domain_name.custom_doname_name.cloudfront_domain_name}"
    zone_id                = "${aws_api_gateway_domain_name.custom_doname_name.cloudfront_zone_id}"
  }
}

resource "aws_api_gateway_base_path_mapping" "custom_resourse_mapping" {
  api_id      = aws_api_gateway_rest_api.api_gateway.id
  stage_name  = aws_api_gateway_deployment.api_deployment.stage_name
  domain_name = aws_api_gateway_domain_name.custom_doname_name.domain_name
}

/////////////// REFERRAL CODE VERIFICATION, STATUS //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "referral_path_root" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part   = "referral"
}

resource "aws_api_gateway_resource" "referral_verify" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.referral_path_root.id
  path_part   = "verify"
}

resource "aws_api_gateway_method" "referral_verify" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.referral_verify.id}"
  http_method   = "POST"
  authorization = "NONE"
}

resource "aws_lambda_permission" "referral_verify" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.referral_verify.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:${var.aws_account}:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "referral_verify" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.referral_verify.resource_id}"
  http_method = "${aws_api_gateway_method.referral_verify.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.referral_verify.invoke_arn}"
}

// FOR GETTING WHETHER CODES ARE REQUIRED OR NOT, AND/OR DEFAULTS

resource "aws_api_gateway_resource" "referral_status" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.referral_path_root.id
  path_part   = "status"
}

resource "aws_api_gateway_method" "referral_status" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.referral_status.id}"
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_lambda_permission" "referral_status" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.referral_status.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:${var.aws_account}:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "referral_status" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.referral_status.resource_id}"
  http_method = "${aws_api_gateway_method.referral_status.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.referral_status.invoke_arn}"
}

// FOR USING A REFERRAL CODE (INCLUDING GETTING CURRENT STATE)

resource "aws_api_gateway_resource" "referral_use" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.referral_path_root.id
  path_part   = "use"
}

resource "aws_api_gateway_method" "referral_use" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.referral_use.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "referral_use" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.referral_use.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:${var.aws_account}:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "referral_use" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.referral_use.resource_id}"
  http_method = "${aws_api_gateway_method.referral_use.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.referral_use.invoke_arn}"
}

/////////////// SAVE API LAMBDA (INITIATE & CHECK) //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "save_path_root" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part   = "addcash"
}

resource "aws_api_gateway_resource" "save_initiate" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.save_path_root.id}"
  path_part   = "initiate"
}

resource "aws_api_gateway_method" "save_initiate" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.save_initiate.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "save_initiate" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.save_initiate.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "save_initiate" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.save_initiate.resource_id}"
  http_method = "${aws_api_gateway_method.save_initiate.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.save_initiate.invoke_arn}"
}

resource "aws_api_gateway_resource" "save_payment_check" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.save_path_root.id}"
  path_part   = "check"
}

resource "aws_api_gateway_method" "save_payment_check" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.save_payment_check.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "save_payment_check" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.save_payment_check.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "save_payment_check" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.save_payment_check.resource_id}"
  http_method = "${aws_api_gateway_method.save_payment_check.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.save_payment_check.invoke_arn}"
}

// INBOUND COMPLETION PAGE STARTS HERE

resource "aws_api_gateway_resource" "save_result_root" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.save_path_root.id
  path_part   = "result"
}

resource "aws_api_gateway_resource" "save_payment_result" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.save_result_root.id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "save_payment_result" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.save_payment_result.id
  http_method   = "ANY" // since redirect is sometimes POST, sometimes GET, and other methods will achieve nothing
  authorization = "NONE" // since this will come in from a redirect
}

resource "aws_lambda_permission" "save_payment_result" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.save_payment_complete.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "save_payment_result" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_method.save_payment_result.resource_id
  http_method   = aws_api_gateway_method.save_payment_result.http_method
  
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.save_payment_complete.invoke_arn
}

// SAVE LOCKS START HERE

resource "aws_api_gateway_resource" "save_lock_path_root" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.save_path_root.id
  path_part     = "lock"
}

resource "aws_api_gateway_resource" "save_lock_manage" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.save_lock_path_root.id
  path_part     = "{proxy+}" 
}

resource "aws_api_gateway_method" "save_lock_manage" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.save_lock_manage.id
  http_method   = "ANY"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "save_lock_manage" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.save_lock.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "save_lock_manage" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.save_lock_manage.id
  http_method   = aws_api_gateway_method.save_lock_manage.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.save_lock.invoke_arn
}

/////////////// ACCOUNT BALANCE LAMBDA (WRAPPER ONLY, SIMPLE GET) -- MAIN LAMBDA ONLY FOR INVOKE /////////////////////////////////////////////////

resource "aws_api_gateway_method" "balance_fetch_wrapper" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.balance_fetch_wrapper.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_api_gateway_resource" "balance_fetch_wrapper" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part   = "balance"
}

resource "aws_lambda_permission" "balance_fetch_wrapper" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.balance_fetch_wrapper.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "balance_fetch_wrapper" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.balance_fetch_wrapper.resource_id}"
  http_method = "${aws_api_gateway_method.balance_fetch_wrapper.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.balance_fetch_wrapper.invoke_arn}"
}

module "balance_cors" {
  source = "./modules/cors"
  api_id          = aws_api_gateway_rest_api.api_gateway.id
  api_resource_id = "${aws_api_gateway_resource.balance_fetch_wrapper.id}"
}

/////////////// SAVING HEAT FETCH ////////////////////////////////////////////////////

resource "aws_api_gateway_method" "user_save_heat_read" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.user_save_heat_read.id
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_api_gateway_resource" "user_save_heat_read" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part     = "heat"
}

resource "aws_lambda_permission" "user_save_heat_read" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.user_save_heat_read.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "user_save_heat_read" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_method.user_save_heat_read.resource_id
  http_method   = aws_api_gateway_method.user_save_heat_read.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.user_save_heat_read.invoke_arn
}

/////////////// FRIEND API FUNCTIONS /////////////////////////////////////////////////

resource "aws_api_gateway_resource" "friend_path_root" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part     = "friend"
}

/////////////// LIST FRIENDS ////////////////////////////////////////////////////////

resource "aws_api_gateway_method" "user_friend_list" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.user_friend_list.id
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_api_gateway_resource" "user_friend_list" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_path_root.id
  path_part       = "list"
}

resource "aws_lambda_permission" "user_friend_list" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.friend_list.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "user_friend_list" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_method.user_friend_list.resource_id
  http_method   = aws_api_gateway_method.user_friend_list.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.friend_list.invoke_arn
}

//////////////// DEACTIVATE A FRIENDSHIP ///////////////////////////////////////////////

resource "aws_api_gateway_resource" "friend_deactivate" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_path_root.id
  path_part     = "deactivate"
}

resource "aws_api_gateway_method" "friend_deactivate" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.friend_deactivate.id
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "friend_deactivate" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.friend_deactivate.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "friend_deactivate" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_method.friend_deactivate.resource_id
  http_method   = aws_api_gateway_method.friend_deactivate.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.friend_deactivate.invoke_arn
}

//////////////// HANDLE FRIEND REQUESTS (USING 1-LAMBDA ROUTER METHOD) ////////////////

resource "aws_api_gateway_resource" "friend_request_path_root" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_path_root.id
  path_part     = "request"
}

resource "aws_api_gateway_resource" "friend_request_manage" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_request_path_root.id
  path_part     = "{proxy+}" 
}

resource "aws_api_gateway_method" "friend_request_manage" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.friend_request_manage.id
  http_method   = "ANY"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "friend_request_manage" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.friend_request_manage.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "friend_request_manage" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.friend_request_manage.id
  http_method   = aws_api_gateway_method.friend_request_manage.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.friend_request_manage.invoke_arn
}

///// CHECK FOR FRIEND ALERTS (SIMILAR TO ABOVE) ///////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "friend_alert_path_root" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_path_root.id
  path_part     = "alert"
}

resource "aws_api_gateway_resource" "friend_alert_manage" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_alert_path_root.id
  path_part     = "{proxy+}" 
}

resource "aws_api_gateway_method" "friend_alert_manage" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.friend_alert_manage.id
  http_method   = "ANY"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "friend_alert_manage" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.friend_alert_manage.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "friend_alert_manage" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.friend_alert_manage.id
  http_method   = aws_api_gateway_method.friend_alert_manage.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.friend_alert_manage.invoke_arn
}

/////////////// FRIEND SAVING POOLS (SPLIT READ, WRITE, PATTERN ABOVE) ////////////////////////////////////

resource "aws_api_gateway_resource" "friend_pool_path_root" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_path_root.id
  path_part     = "pool"
}

// READING
resource "aws_api_gateway_resource" "friend_pool_read_path_root" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_pool_path_root.id
  path_part     = "read"
}

resource "aws_api_gateway_resource" "friend_pool_read" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_pool_read_path_root.id
  path_part     = "{proxy+}" 
}

resource "aws_api_gateway_method" "friend_pool_read" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.friend_pool_read.id
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "friend_pool_read" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.friend_pool_read.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "friend_pool_read" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.friend_pool_read.id
  http_method   = aws_api_gateway_method.friend_pool_read.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.friend_pool_read.invoke_arn
}

// WRITE
resource "aws_api_gateway_resource" "friend_pool_write_path_root" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_pool_path_root.id
  path_part     = "write"
}

resource "aws_api_gateway_resource" "friend_pool_write" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_pool_write_path_root.id
  path_part     = "{proxy+}" 
}

resource "aws_api_gateway_method" "friend_pool_write" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.friend_pool_write.id
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "friend_pool_write" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.friend_pool_write.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "friend_pool_write" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.friend_pool_write.id
  http_method   = aws_api_gateway_method.friend_pool_write.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.friend_pool_write.invoke_arn
}

/////////////// FRIEND TOURNAMENTS (ACTUALLY INVOKES BOOST) ////////////////////////////////////

resource "aws_api_gateway_method" "user_friend_tournament" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.user_friend_tournament.id
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_api_gateway_resource" "user_friend_tournament" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  parent_id     = aws_api_gateway_resource.friend_path_root.id
  path_part     = "tournament"
}

resource "aws_lambda_permission" "user_friend_tournament" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.boost_create_wrapper.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "user_friend_tournament" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_method.user_friend_tournament.resource_id
  http_method   = aws_api_gateway_method.user_friend_tournament.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.boost_create_wrapper.invoke_arn
}

/////////////// USER HISTORY LAMBDA (OWN USER, NOT ADMIN) /////////////////////////////////////////////////

// in future we will probably add some more endpoints like graphing etc., so just future-proofing
resource "aws_api_gateway_resource" "history_path_root" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part   = "history"
}

resource "aws_api_gateway_method" "user_history_list" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.user_history_list.id
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_api_gateway_resource" "user_history_list" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.history_path_root.id
  path_part   = "list"
}

resource "aws_lambda_permission" "user_history_list" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.user_history_list.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "user_history_list" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = aws_api_gateway_method.user_history_list.resource_id
  http_method = aws_api_gateway_method.user_history_list.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.user_history_list.invoke_arn
}

/////////////// PENDING STATUS CHECK LAMBDA ////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "pending_path_root" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part   = "pending"
}

resource "aws_api_gateway_resource" "transaction_pending_handle" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.pending_path_root.id
  path_part   = "{proxy+}"
}

resource "aws_api_gateway_method" "transaction_pending_handle" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.transaction_pending_handle.id
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "transaction_pending_handle" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.transaction_pending_handle.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "transaction_pending_handle" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_method.transaction_pending_handle.resource_id
  http_method   = aws_api_gateway_method.transaction_pending_handle.http_method
  
  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.transaction_pending_handle.invoke_arn
}


/////////////// MESSAGING LAMBDAS //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "message_path_root" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part   = "message"
}

/// FETCH MESSAGE

resource "aws_api_gateway_resource" "message_fetch_wrapper" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.message_path_root.id}"
  path_part   = "fetch"
}

resource "aws_api_gateway_method" "message_fetch_wrapper" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.message_fetch_wrapper.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "message_fetch_wrapper" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.message_user_fetch.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "message_fetch_wrapper" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.message_fetch_wrapper.resource_id}"
  http_method = "${aws_api_gateway_method.message_fetch_wrapper.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.message_user_fetch.invoke_arn}"
}

// PROCESS MESSAGE, EG MARK IT DISMISSED OR DELIVERED

resource "aws_api_gateway_resource" "message_process" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.message_path_root.id}"
  path_part   = "process"
}

resource "aws_api_gateway_method" "message_process" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.message_process.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "message_process" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.message_user_process.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "message_process" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = aws_api_gateway_method.message_process.resource_id
  http_method = aws_api_gateway_method.message_process.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.message_user_process.invoke_arn
}

// FETCH USER MESSAGE HISTORY

resource "aws_api_gateway_resource" "message_user_history" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.message_path_root.id}"
  path_part   = "history"
}

resource "aws_api_gateway_method" "message_user_history" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.message_user_history.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "message_user_history" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.message_user_history.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "message_user_history" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.message_user_history.resource_id}"
  http_method = "${aws_api_gateway_method.message_user_history.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.message_user_history.invoke_arn}"
}

// STORE PUSH NOTIFICATION TOKEN FOR USER

resource "aws_api_gateway_resource" "message_token_manage" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.message_path_root.id}"
  path_part   = "token"
}

resource "aws_api_gateway_method" "message_token_store" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.message_token_manage.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "message_token_store" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.message_token_manage.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "message_token_store" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.message_token_store.resource_id}"
  http_method = "${aws_api_gateway_method.message_token_store.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.message_token_manage.invoke_arn}"
}

// DELETE PUSH NOTIFICATION TOKEN FOR USER

resource "aws_api_gateway_method" "message_token_delete" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.message_token_manage.id}"
  http_method   = "DELETE"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "message_token_delete" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.message_token_manage.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "message_token_delete" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.message_token_delete.resource_id}"
  http_method = "${aws_api_gateway_method.message_token_delete.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.message_token_manage.invoke_arn}"
}

/////////////// BOOST LAMBDAS //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "boost_path_root" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part   = "boost"
}

/// BOOST PROCESS

resource "aws_api_gateway_resource" "boost_user_process" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.boost_path_root.id
  path_part   = "respond"
}

resource "aws_api_gateway_method" "boost_user_process" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.boost_user_process.id
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "boost_user_process" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.boost_user_process.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "boost_user_process" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = aws_api_gateway_method.boost_user_process.resource_id
  http_method = aws_api_gateway_method.boost_user_process.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.boost_user_process.invoke_arn
}

/// BOOST LIST

resource "aws_api_gateway_resource" "boost_user_list" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.boost_path_root.id}"
  path_part   = "list"
}

resource "aws_api_gateway_method" "boost_user_list" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.boost_user_list.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "boost_user_list" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.boost_user_list.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "boost_user_list" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.boost_user_list.resource_id}"
  http_method = "${aws_api_gateway_method.boost_user_list.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.boost_user_list.invoke_arn}"
}

// GET RECENTLY CHANGED BOOSTS

resource "aws_api_gateway_resource" "boost_user_changed" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.boost_path_root.id}"
  path_part   = "display"
}

resource "aws_api_gateway_method" "boost_user_changed" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.boost_user_changed.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "boost_user_changed" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.boost_user_changed.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "boost_user_changed" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = aws_api_gateway_method.boost_user_changed.resource_id
  http_method = aws_api_gateway_method.boost_user_changed.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.boost_user_changed.invoke_arn
}

// GET DETAIL ON A BOOST (MOSTLY FOR FRIEND TOURNAMENTS)

resource "aws_api_gateway_resource" "boost_detail_fetch" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.boost_path_root.id}"
  path_part   = "detail"
}

resource "aws_api_gateway_method" "boost_detail_fetch" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.boost_detail_fetch.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "boost_detail_fetch" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.boost_detail_fetch.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "boost_detail_fetch" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.boost_detail_fetch.resource_id}"
  http_method = "${aws_api_gateway_method.boost_detail_fetch.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.boost_detail_fetch.invoke_arn}"
}

/////////////// SNIPPET LAMBDAS //////////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "snippet_path_root" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part   = "snippet"
}

// FETCH ORDERED LIST OF SNIPPETS TO SHOW USER

resource "aws_api_gateway_resource" "snippet_user_fetch" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.snippet_path_root.id
  path_part   = "fetch"
}

resource "aws_api_gateway_method" "snippet_user_fetch" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.snippet_user_fetch.id
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "snippet_user_fetch" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.snippet_user_fetch.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "snippet_user_fetch" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = aws_api_gateway_method.snippet_user_fetch.resource_id
  http_method = aws_api_gateway_method.snippet_user_fetch.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.snippet_user_fetch.invoke_arn
}

// UPDATE SNIPPET USER STATE (EG INCREMENT VIEW COUNT)

resource "aws_api_gateway_resource" "snippet_user_update" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.snippet_path_root.id
  path_part   = "update"
}

resource "aws_api_gateway_method" "snippet_user_update" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.snippet_user_update.id
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "snippet_user_update" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.snippet_user_update.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "snippet_user_update" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = aws_api_gateway_method.snippet_user_update.resource_id
  http_method = aws_api_gateway_method.snippet_user_update.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.snippet_user_update.invoke_arn
}

/////////////// WITHDRAW API LAMBDA (INITIATE, ADD AMOUNT, FINISH) ///////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "withdraw_path_root" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_rest_api.api_gateway.root_resource_id
  path_part   = "withdrawal"
}

// first step -- initiate, check bank account
resource "aws_api_gateway_resource" "withdraw_initiate" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = aws_api_gateway_resource.withdraw_path_root.id
  path_part   = "initiate"
}

resource "aws_api_gateway_method" "withdraw_initiate" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = aws_api_gateway_resource.withdraw_initiate.id
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "withdraw_initiate" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.withdraw_initiate.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "withdraw_initiate" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = aws_api_gateway_method.withdraw_initiate.resource_id
  http_method = aws_api_gateway_method.withdraw_initiate.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.withdraw_initiate.invoke_arn
}

// second step -- add an amount, decide on boost to avoid or not
resource "aws_api_gateway_resource" "withdraw_update" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.withdraw_path_root.id}"
  path_part   = "amount"
}

resource "aws_api_gateway_method" "withdraw_update" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.withdraw_update.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "withdraw_update" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.withdraw_update.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "withdraw_update" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.withdraw_update.resource_id}"
  http_method = "${aws_api_gateway_method.withdraw_update.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.withdraw_update.invoke_arn}"
}

// final step -- decision
resource "aws_api_gateway_resource" "withdraw_end" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  parent_id   = "${aws_api_gateway_resource.withdraw_path_root.id}"
  path_part   = "decision"
}

resource "aws_api_gateway_method" "withdraw_end" {
  rest_api_id   = aws_api_gateway_rest_api.api_gateway.id
  resource_id   = "${aws_api_gateway_resource.withdraw_end.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = aws_api_gateway_authorizer.jwt_authorizer.id
}

resource "aws_lambda_permission" "withdraw_end" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.withdraw_end.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "withdraw_end" {
  rest_api_id = aws_api_gateway_rest_api.api_gateway.id
  resource_id = "${aws_api_gateway_method.withdraw_end.resource_id}"
  http_method = "${aws_api_gateway_method.withdraw_end.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.withdraw_end.invoke_arn}"
}
