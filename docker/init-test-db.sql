-- 测试库。只在数据目录第一次初始化时执行。
CREATE DATABASE resume_test OWNER resume;
\connect resume_test
CREATE EXTENSION IF NOT EXISTS vector;
