// Splitting these out as main api gateway becoming excessively long; also may want to use different authorizer in future

resource "aws_api_gateway_rest_api" "admin_api_gateway" {
    name    = "${terraform.workspace}_admin_rest_api"
}

resource "aws_api_gateway_deployment" "admin_api_deployment" {
    rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
    stage_name = "${terraform.workspace}"

    depends_on = [
        aws_api_gateway_integration.admin_user_count,
        aws_api_gateway_integration.admin_user_find,
        aws_api_gateway_integration.admin_user_manage,
        aws_api_gateway_integration.message_instruct_create,
        aws_api_gateway_integration.message_instruct_list,
        aws_api_gateway_integration.message_instruct_update,
        aws_api_gateway_integration.boost_admin_create,
        aws_api_gateway_integration.boost_admin_list,
        aws_api_gateway_integration.admin_client_float_list,
        aws_api_gateway_integration.admin_client_float_fetch,
        aws_api_gateway_integration.admin_client_float_edit
    ]

    variables = {
        commit_sha1 = "${var.deploy_code_commit_hash}"
    }

    lifecycle {
        create_before_destroy = true
    }
}

/////////////////////// API GW AUTHORIZER ///////////////////////////////////////////////////////////////

// note : have to replicate, because authorizer is within "namespace" (sort of) of its API GW

resource "aws_api_gateway_authorizer" "admin_jwt_authorizer" {
  name = "admin_api_gateway_jwt_authorizer_${terraform.workspace}"
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  type = "TOKEN"
  authorizer_uri = "arn:aws:apigateway:${var.aws_default_region[terraform.workspace]}:lambda:path/2015-03-31/functions/${var.jwt_authorizer_arn[terraform.workspace]}/invocations"
}

/////////////////////// API GW LOGGING ///////////////////////////////////////////////////////////////

// note : also reusing a bunch from ops
resource "aws_api_gateway_method_settings" "api_admin_settings" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  stage_name  = "${aws_api_gateway_deployment.admin_api_deployment.stage_name}"
  method_path = "*/*"

  settings {
    # Enable CloudWatch logging and metrics
    metrics_enabled        = true
    data_trace_enabled     = true
    logging_level          = "INFO"

    # Limit the rate of calls to prevent abuse and unwanted charges (and as this is admin, so without heavy use, throttle it a lot)
    throttling_rate_limit  = 20
    throttling_burst_limit = 10
  }
}

/////////////////////// API GW DOMAIN ////////////////////////////////////////////////////////////////

resource "aws_api_gateway_domain_name" "admin_custom_domain_name" {
  certificate_arn = "arn:aws:acm:us-east-1:455943420663:certificate/6fb77289-8ee8-420a-8f5b-6d62782e091e"
  domain_name     = "${terraform.workspace}-admin.jupiterapp.net"
}

resource "aws_route53_record" "admin_api_route" {
  name    = "${aws_api_gateway_domain_name.admin_custom_domain_name.domain_name}"
  type    = "A"
  zone_id = "Z32F5PRK3A4ONK"

  alias {
    evaluate_target_health = true
    name                   = "${aws_api_gateway_domain_name.admin_custom_domain_name.cloudfront_domain_name}"
    zone_id                = "${aws_api_gateway_domain_name.admin_custom_domain_name.cloudfront_zone_id}"
  }
}

resource "aws_api_gateway_base_path_mapping" "admin_api_resource_mapping" {
  api_id      = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  stage_name  = "${aws_api_gateway_deployment.admin_api_deployment.stage_name}"
  domain_name = "${aws_api_gateway_domain_name.admin_custom_domain_name.domain_name}"
}

//////////////////////// LAMBDA MAPPINGS NOW START ////////////////////////////////////////////////////

/////////////////////// USER COUNTS ///////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "admin_user_path_root" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.admin_api_gateway.root_resource_id}"
  path_part   = "user"
}

resource "aws_api_gateway_resource" "admin_user_count" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.admin_user_path_root.id}"
  path_part   = "count"
}

resource "aws_api_gateway_method" "admin_user_count" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.admin_user_count.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "admin_user_count" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.admin_user_count.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "admin_user_count" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.admin_user_count.resource_id}"
  http_method = "${aws_api_gateway_method.admin_user_count.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.admin_user_count.invoke_arn}"
}

module "admin_user_count_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.admin_user_count.id}"
}

/////////////////////// USER FETCH ///////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "admin_user_find" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.admin_user_path_root.id}"
  path_part   = "find"
}

resource "aws_api_gateway_method" "admin_user_find" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.admin_user_find.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "admin_user_find" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.admin_user_find.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "admin_user_find" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.admin_user_find.resource_id}"
  http_method = "${aws_api_gateway_method.admin_user_find.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.admin_user_find.invoke_arn}"
}

module "admin_user_find_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.admin_user_find.id}"
}

/////////////////////// USER MANAGE ///////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "admin_user_manage" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.admin_user_path_root.id}"
  path_part   = "manage"
}

resource "aws_api_gateway_method" "admin_user_manage" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.admin_user_manage.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "admin_user_manage" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.admin_user_manage.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "admin_user_manage" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.admin_user_manage.resource_id}"
  http_method = "${aws_api_gateway_method.admin_user_manage.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.admin_user_manage.invoke_arn}"
}

module "admin_user_manage_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.admin_user_manage.id}"
}

//////////////////////// CLIENT & FLOAT MANAGEMENT /////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "admin_client_path_root" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.admin_api_gateway.root_resource_id}"
  path_part   = "client"
}

// LIST THE CLIENTS AND FLOATS

resource "aws_api_gateway_resource" "admin_client_float_list" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.admin_client_path_root.id}"
  path_part   = "list"
}

resource "aws_api_gateway_method" "admin_client_float_list" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.admin_client_float_list.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "admin_client_float_list" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.admin_client_float_list.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "admin_client_float_list" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.admin_client_float_list.resource_id}"
  http_method = "${aws_api_gateway_method.admin_client_float_list.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.admin_client_float_list.invoke_arn}"
}

module "client_float_list_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.admin_client_float_list.id}"
}

// FETCH A CLIENT AND FLOATS

resource "aws_api_gateway_resource" "admin_client_float_fetch" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.admin_client_path_root.id}"
  path_part   = "fetch"
}

resource "aws_api_gateway_method" "admin_client_float_fetch" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.admin_client_float_fetch.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "admin_client_float_fetch" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.admin_client_float_fetch.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "admin_client_float_fetch" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.admin_client_float_fetch.resource_id}"
  http_method = "${aws_api_gateway_method.admin_client_float_fetch.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.admin_client_float_fetch.invoke_arn}"
}

module "client_float_fetch_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.admin_client_float_fetch.id}"
}

// "EDIT" A FLOAT, I.E., PERFORM A RANGE OF OPERATIONS ON ACCRUAL VARS, AND SO FORTH

resource "aws_api_gateway_resource" "admin_client_float_edit" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.admin_client_path_root.id}"
  path_part   = "edit"
}

resource "aws_api_gateway_method" "admin_client_float_edit" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.admin_client_float_edit.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "admin_client_float_edit" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.admin_client_float_edit.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "admin_client_float_edit" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.admin_client_float_edit.resource_id}"
  http_method = "${aws_api_gateway_method.admin_client_float_edit.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.admin_client_float_edit.invoke_arn}"
}

module "client_float_edit_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.admin_client_float_edit.id}"
}

/////////////////////// MESSAGING /////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "admin_message_path_root" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.admin_api_gateway.root_resource_id}"
  path_part   = "message"
}

// CREATE A MESSAGE INSTRUCTION
// this is for the couple of message instruct endpoints
resource "aws_api_gateway_resource" "message_instruct_path_root" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.admin_message_path_root.id}"
  path_part   = "instruct"
}

resource "aws_api_gateway_resource" "message_instruct_create" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.message_instruct_path_root.id}"
  path_part   = "create"
}

resource "aws_api_gateway_method" "message_instruct_create" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.message_instruct_create.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "message_instruct_create" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.message_instruct_create.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "message_instruct_create" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.message_instruct_create.resource_id}"
  http_method = "${aws_api_gateway_method.message_instruct_create.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.message_instruct_create.invoke_arn}"
}

module "message_create_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.message_instruct_create.id}"
}

// LIST MESSAGE INSTRUCTIONS (ALSO ONLY FOR ADMIN -- ADD TO AUTHORIZER IN TIME)
resource "aws_api_gateway_resource" "message_instruct_list" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.message_instruct_path_root.id}"
  path_part   = "list"
}

resource "aws_api_gateway_method" "message_instruct_list" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.message_instruct_list.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "message_instruct_list" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.message_instruct_list.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "message_instruct_list" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.message_instruct_list.resource_id}"
  http_method = "${aws_api_gateway_method.message_instruct_list.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.message_instruct_list.invoke_arn}"
}

module "message_list_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.message_instruct_list.id}"
}

// UPDATE MESSAGE INSTRUCTION (ALSO ONLY FOR ADMIN)

resource "aws_api_gateway_resource" "message_instruct_update" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.message_instruct_path_root.id}"
  path_part   = "update"
}

resource "aws_api_gateway_method" "message_instruct_update" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.message_instruct_update.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "message_instruct_update" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.message_instruct_update.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "message_instruct_update" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.message_instruct_update.resource_id}"
  http_method = "${aws_api_gateway_method.message_instruct_update.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.message_instruct_update.invoke_arn}"
}

module "message_update_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.message_instruct_update.id}"
}

/////////////////////// BOOSTS /////////////////////////////////////////////////////////////////////

resource "aws_api_gateway_resource" "admin_boost_path_root" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_rest_api.admin_api_gateway.root_resource_id}"
  path_part   = "boost"
}

/// BOOST CREATE

resource "aws_api_gateway_resource" "boost_admin_create" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.admin_boost_path_root.id}"
  path_part   = "create"
}

resource "aws_api_gateway_method" "boost_admin_create" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.boost_admin_create.id}"
  http_method   = "POST"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "boost_admin_create" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.boost_create_wrapper.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "boost_admin_create" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.boost_admin_create.resource_id}"
  http_method = "${aws_api_gateway_method.boost_admin_create.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.boost_create_wrapper.invoke_arn}"
}

module "boost_admin_create_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.boost_admin_create.id}"
}

/// BOOST LIST (note: there will be boost/user list in future)

resource "aws_api_gateway_resource" "boost_admin_list" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  parent_id   = "${aws_api_gateway_resource.admin_boost_path_root.id}"
  path_part   = "list"
}

resource "aws_api_gateway_method" "boost_admin_list" {
  rest_api_id   = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id   = "${aws_api_gateway_resource.boost_admin_list.id}"
  http_method   = "GET"
  authorization = "CUSTOM"
  authorizer_id = "${aws_api_gateway_authorizer.admin_jwt_authorizer.id}"
}

resource "aws_lambda_permission" "boost_admin_list" {
  action        = "lambda:InvokeFunction"
  function_name = "${aws_lambda_function.boost_admin_list.function_name}"
  principal     = "apigateway.amazonaws.com"
  source_arn    = "arn:aws:execute-api:${var.aws_default_region[terraform.workspace]}:455943420663:${aws_api_gateway_rest_api.admin_api_gateway.id}/*/*/*"
}

resource "aws_api_gateway_integration" "boost_admin_list" {
  rest_api_id = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  resource_id = "${aws_api_gateway_method.boost_admin_list.resource_id}"
  http_method = "${aws_api_gateway_method.boost_admin_list.http_method}"

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = "${aws_lambda_function.boost_admin_list.invoke_arn}"
}

module "boost_admin_list_cors" {
  source = "./modules/cors"
  api_id          = "${aws_api_gateway_rest_api.admin_api_gateway.id}"
  api_resource_id = "${aws_api_gateway_resource.boost_admin_list.id}"
}