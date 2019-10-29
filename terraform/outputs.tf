output "aws_default_region" {
  value = "${var.aws_default_region["${terraform.workspace}"]}"
}

output "workspace" {
  value = terraform.workspace
}

output "cache" {
  value = "${aws_elasticache_cluster.ops_redis_cache.cache_nodes.0.address}"
}

output "db_endpoint" {
  value = "${local.database_config.host}"
}

output "api_gw_url" {
  value = "${aws_api_gateway_deployment.api_deployment.invoke_url}"
}

output "custom_url" {
  value = "${aws_api_gateway_domain_name.custom_doname_name.domain_name}"
}
