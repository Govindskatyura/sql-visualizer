select a, b,c from tableA;

select A.ID, B.ID,A.name,B.age from tableA A 
left join TableB B on 
A.id=B.id;
