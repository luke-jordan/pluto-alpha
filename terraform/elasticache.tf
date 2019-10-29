/* ELASTICACHE */

resource "aws_elasticache_subnet_group" "elasticache_subnet_group" {
    name = "${terraform.workspace}-rds-subnet-group"
    description = "Elasticache subnet group"
    subnet_ids = [for subnet in aws_subnet.private : subnet.id]

    depends_on = [
        "aws_subnet.private"
    ]
}

resource "aws_elasticache_cluster" "ops_redis_cache" {
    cluster_id = "${terraform.workspace}-ops-cache"
    engine = "redis"
    node_type = "cache.t2.micro"
    num_cache_nodes = 1
    parameter_group_name = "default.redis3.2"
    engine_version = "3.2.10"
    port = 6379

    subnet_group_name = "${aws_elasticache_subnet_group.elasticache_subnet_group.name}"
    security_group_ids = ["${aws_security_group.sg_cache_6379_ingress.id}"]

    tags = {
        "environment" = "${terraform.workspace}"
    }
}
